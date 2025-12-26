import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { User, UserRole } from '../users/entities/user.entity';
import { isFixedAdminEmail } from 'src/common/constants/fixed-admin';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestResetDto } from './dto/request-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { EmailService } from '../email/email.service';

import { AccountRecoverRequestDto } from './dto/account-recover-request.dto';
import { AccountRecoverConfirmDto } from './dto/account-recover-confirm.dto';
import { SmsService } from '../sms/sms.service';

type VerifyInfo = {
  required: true;
  via: 'email' | 'phone';
  target: string; // masked
  expiresAt: Date;
  sent: boolean;
  cooldownRemaining?: number;
};

export type LoginResult =
  | { needRecover: true; identifier: string; via: 'email' | 'phone' }
  | {
      user: {
        id: number;
        name: string;
        email: string | null;
        phone: string | null;
        role: UserRole;
        isVerified: boolean;
      };
      access_token: string;
      refresh_token: string;
      verify?: VerifyInfo; // 👈 login xong chưa verify => có field này
    };

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly emailSvc: EmailService,
    private readonly smsSvc: SmsService,
  ) {}

  // ========= Helpers =========
  private get pepper() {
    return this.config.get<string>('BCRYPT_PEPPER');
  }
  private get otpWindowMinutes() {
    return Number(this.config.get('OTP_WINDOW_MINUTES') ?? 5);
  }
  private get otpResendCooldownSec() {
    return Number(this.config.get('OTP_RESEND_COOLDOWN_SECONDS') ?? 60);
  }

  private async hashPassword(raw: string) {
    const rounds = Number(this.config.get('BCRYPT_SALT_ROUNDS') ?? 12);
    const toHash = this.pepper ? raw + this.pepper : raw;
    return bcrypt.hash(toHash, rounds);
  }

  private async comparePassword(raw: string, hash: string) {
    const toCompare = this.pepper ? raw + this.pepper : raw;
    return bcrypt.compare(toCompare, hash);
  }

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private normalizeEmail(email?: string | null) {
    const v = (email ?? '').trim();
    return v ? v.toLowerCase() : null;
  }

  // VN normalize:
  // 090xxxxxxx -> +8490xxxxxxx
  // 84xxxxxxxxx -> +84xxxxxxxxx
  // +84xxxxxxxxx giữ nguyên
  private normalizePhone(phone?: string | null) {
    const raw = (phone ?? '').trim();
    if (!raw) return null;

    if (/^\+\d{8,15}$/.test(raw)) return raw;
    if (/^84\d{8,15}$/.test(raw)) return `+${raw}`;
    if (/^0\d{9,10}$/.test(raw)) return `+84${raw.slice(1)}`;

    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

    throw new BadRequestException('Số điện thoại không hợp lệ');
  }

  private requireEmail(user: User): string {
    if (!user.email) throw new BadRequestException('Tài khoản không có email');
    return user.email;
  }

  private requirePhone(user: User): string {
    if (!user.phone) throw new BadRequestException('Tài khoản không có số điện thoại');
    return user.phone;
  }

  private maskEmail(email: string) {
    const [u, d] = email.split('@');
    const head = u.slice(0, 2);
    return `${head}***@${d}`;
  }

  private maskPhone(phone: string) {
    const tail = phone.slice(-3);
    return `***${tail}`;
  }

  private async generateTokens(user: User) {
    const atSecret = this.config.get<string>('ACCESS_TOKEN_SECRET', 'change_me');
    const atExpires = this.config.get<string>('ACCESS_TOKEN_EXPIRES', '15m');
    const rtSecret = this.config.get<string>('REFRESH_TOKEN_SECRET', 'change_me_too');
    const rtExpires = this.config.get<string>('REFRESH_TOKEN_EXPIRES', '7d');

    const payload = { sub: user.id, email: user.email, phone: user.phone, role: user.role };

    const [access_token, refresh_token] = await Promise.all([
      this.jwt.signAsync(payload, { secret: atSecret, expiresIn: atExpires }),
      this.jwt.signAsync({ sub: user.id }, { secret: rtSecret, expiresIn: rtExpires }),
    ]);

    return { access_token, refresh_token };
  }

  private async generateAccessToken(user: User) {
    const atSecret = this.config.get<string>('ACCESS_TOKEN_SECRET', 'change_me');
    const atExpires = this.config.get<string>('ACCESS_TOKEN_EXPIRES', '15m');
    const payload = { sub: user.id, email: user.email, phone: user.phone, role: user.role };
    return this.jwt.signAsync(payload, { secret: atSecret, expiresIn: atExpires });
  }

  // Login cần nhìn cả bản ghi đã xoá mềm để “kẹp” luồng khôi phục
  private async validateUser(identifierRaw: string, password: string) {
    const raw = identifierRaw.trim();
    const byEmail = raw.includes('@');

    const qb = this.usersRepo
      .createQueryBuilder('u')
      .withDeleted()
      .addSelect('u.passwordHash');

    if (byEmail) {
      const email = raw.toLowerCase();
      qb.where('u.email = :email', { email });
    } else {
      const phoneNorm = this.normalizePhone(raw);
      // match raw OR normalized để không chết data cũ
      qb.where('u.phone = :p1', { p1: raw }).orWhere('u.phone = :p2', { p2: phoneNorm });
    }

    const user = await qb.getOne();

    if (!user) throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');

    const ok = await this.comparePassword(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Email/SĐT hoặc mật khẩu không đúng');

    return user;
  }

  // gửi OTP verify theo kênh (email/phone) + cooldown
  private async sendVerifyOtp(user: User, preferred: 'email' | 'phone'): Promise<VerifyInfo> {
    let via: 'email' | 'phone' = preferred;

    // fallback nếu thiếu field
    if (via === 'email' && !user.email && user.phone) via = 'phone';
    if (via === 'phone' && !user.phone && user.email) via = 'email';

    if (via === 'email' && !user.email) throw new BadRequestException('Tài khoản không có email để gửi OTP');
    if (via === 'phone' && !user.phone) throw new BadRequestException('Tài khoản không có SĐT để gửi OTP');

    // cooldown
    if (user.timeOtp) {
      const now = Date.now();
      const lastSend = user.timeOtp.getTime() - this.otpWindowMinutes * 60 * 1000;
      const deltaSec = (now - lastSend) / 1000;

      if (deltaSec < this.otpResendCooldownSec) {
        const remain = Math.ceil(this.otpResendCooldownSec - deltaSec);
        return {
          required: true,
          via,
          target: via === 'email' ? this.maskEmail(this.requireEmail(user)) : this.maskPhone(this.requirePhone(user)),
          expiresAt: user.timeOtp,
          sent: false,
          cooldownRemaining: remain,
        };
      }
    }

    const otp = this.generateOtp();
    const otpHash = await this.hashPassword(otp);
    const expiresAt = new Date(Date.now() + this.otpWindowMinutes * 60 * 1000);

    user.otp = otpHash as any;
    user.timeOtp = expiresAt as any;
    await this.usersRepo.save(user);

    try {
      if (via === 'email') {
        const email = this.requireEmail(user);
        await this.emailSvc.sendActivationCode(email, otp);
      } else {
        const phoneRaw = this.requirePhone(user);
        const phone = this.normalizePhone(phoneRaw);
        if (!phone) throw new Error('Invalid phone');
        await this.smsSvc.sendOtp(phone, otp);
      }
    } catch (e: any) {
      throw new InternalServerErrorException(`Gửi OTP thất bại: ${e?.message ?? 'Unknown error'}`);
    }

    return {
      required: true,
      via,
      target: via === 'email' ? this.maskEmail(this.requireEmail(user)) : this.maskPhone(this.requirePhone(user)),
      expiresAt,
      sent: true,
      // nếu bạn muốn DEV trả otp thì tự thêm ở controller/service theo NODE_ENV
    };
  }

  // ========= Register =========
  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email ?? null);
    const phoneNorm = this.normalizePhone(dto.phone ?? null);

    if (!email && !phoneNorm) {
      throw new BadRequestException('Phải nhập email hoặc số điện thoại');
    }

    if (email && isFixedAdminEmail(email)) {
      throw new ConflictException('Email đã tồn tại');
    }

    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('confirmPassword phải trùng với password');
    }

    if (email) {
      const exists = await this.usersRepo.findOne({ where: { email } });
      if (exists) throw new ConflictException('Email đã tồn tại');
    }

    if (phoneNorm) {
      const existsPhone = await this.usersRepo
        .createQueryBuilder('u')
        .where('u.phone = :p1', { p1: (dto.phone ?? '').trim() })
        .orWhere('u.phone = :p2', { p2: phoneNorm })
        .getOne();
      if (existsPhone) throw new ConflictException('Số điện thoại đã tồn tại');
    }

    const passwordHash = await this.hashPassword(dto.password);

    const userData: DeepPartial<User> = {
      name: dto.name.trim(),
      email: email ?? undefined,
      phone: phoneNorm ?? undefined,
      passwordHash,
      role: UserRole.USER,
      isVerified: false,
    };


    const user = this.usersRepo.create(userData);
    const saved = await this.usersRepo.save(user);

    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      phone: saved.phone,
      role: saved.role,
      isVerified: saved.isVerified,
      createdAt: saved.createdAt,
    };
  }

  // ========= Login (kẹp luồng khôi phục + auto send OTP nếu chưa verify) =========
  async login(dto: LoginDto): Promise<LoginResult> {
    const identifier = (dto.email ?? dto.phone ?? '').trim();
    if (!identifier) throw new BadRequestException('Thiếu email hoặc số điện thoại');

    const user = await this.validateUser(identifier, dto.password);

    if (user.deletedAt) {
      const via: 'email' | 'phone' = identifier.includes('@') ? 'email' : 'phone';
      return {
        needRecover: true,
        identifier: via === 'email' ? (user.email ?? identifier) : (user.phone ?? identifier),
        via,
      };
    }

    this.usersRepo.update({ id: user.id }, { lastLoginAt: new Date() }).catch(() => void 0);

    const tokens = await this.generateTokens(user);

    const result: any = {
      ...tokens,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      },
    };

    // ✅ chưa verify => tự gửi OTP theo kênh user dùng để login
    if (!user.isVerified) {
      const pref: 'email' | 'phone' = identifier.includes('@') ? 'email' : 'phone';
      result.verify = await this.sendVerifyOtp(user, pref);
    }

    return result;
  }

  // ========= Refresh (KHÔNG rotate refresh token) =========
  async refresh(refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException('Thiếu refresh token');

    const secret = this.config.get<string>('REFRESH_TOKEN_SECRET', 'change_me');
    let decoded: any;
    try {
      decoded = await this.jwt.verifyAsync(refreshToken, { secret });
    } catch {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    const user = await this.usersRepo.findOne({ where: { id: decoded.sub } });
    if (!user) throw new UnauthorizedException('Không tìm thấy người dùng');

    const access_token = await this.generateAccessToken(user);
    return {
      access_token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      },
    };
  }

  // ========= Forgot Password (email) =========
  async requestPasswordReset(dto: RequestResetDto) {
    const email = dto.email.trim().toLowerCase();
    if (isFixedAdminEmail(email)) {
      throw new ForbiddenException('Không thể thay đổi tài khoản admin hệ thống');
    }
    const user = await this.usersRepo.findOne({ where: { email } });

    if (!user) throw new NotFoundException('Email không tồn tại');

    // cooldown resend
    if (user.timeOtp) {
      const now = Date.now();
      const lastSend = user.timeOtp.getTime() - this.otpWindowMinutes * 60 * 1000;
      if ((now - lastSend) / 1000 < this.otpResendCooldownSec) {
        const remain = Math.ceil(this.otpResendCooldownSec - (now - lastSend) / 1000);
        throw new BadRequestException(`Vui lòng đợi ${remain}s trước khi yêu cầu lại OTP`);
      }
    }

    const otp = this.generateOtp();
    const otpHash = await this.hashPassword(otp);

    user.otp = otpHash as any;
    user.timeOtp = new Date(Date.now() + this.otpWindowMinutes * 60 * 1000);
    await this.usersRepo.save(user);

    await this.emailSvc.sendPasswordResetCode(this.requireEmail(user), otp);

    return { email: user.email, otp, expiresAt: user.timeOtp };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    if (isFixedAdminEmail(email)) {
      throw new ForbiddenException('Không thể thay đổi tài khoản admin hệ thống');
    }
    const user = await this.usersRepo
      .createQueryBuilder('u')
      .addSelect(['u.otp', 'u.passwordHash'])
      .where('u.email = :email', { email })
      .getOne();

    if (!user) throw new NotFoundException('Email không tồn tại');

    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('confirmPassword phải trùng với password');
    }

    if (!user.timeOtp || user.timeOtp.getTime() < Date.now()) {
      throw new BadRequestException('OTP đã hết hạn, vui lòng yêu cầu lại');
    }
    if (!user.otp) {
      throw new BadRequestException('OTP không hợp lệ, vui lòng yêu cầu lại');
    }

    const ok = await this.comparePassword(dto.otp, user.otp);
    if (!ok) throw new BadRequestException('OTP không đúng');

    const newHash = await this.hashPassword(dto.password);
    user.passwordHash = newHash as any;
    user.otp = null as any;
    user.timeOtp = null as any;
    await this.usersRepo.save(user);

    return { reset: true };
  }

  // ========= Recover (email/phone) =========
  async requestAccountRecover(dto: AccountRecoverRequestDto) {
    const raw = dto.email.trim();
    const byEmail = raw.includes('@');
    const value = byEmail ? raw.toLowerCase() : raw;
    if (byEmail && isFixedAdminEmail(value)) {
      throw new ForbiddenException('Không thể thay đổi tài khoản admin hệ thống');
    }

    const qb = this.usersRepo.createQueryBuilder('u').withDeleted();
    if (byEmail) qb.where('u.email = :v', { v: value });
    else {
      const phoneNorm = this.normalizePhone(value);
      qb.where('u.phone = :p1', { p1: value }).orWhere('u.phone = :p2', { p2: phoneNorm });
    }

    const user = await qb.getOne();

    if (!user || !user.deletedAt) {
      return { sent: true };
    }

    // cooldown
    if (user.timeOtp) {
      const now = Date.now();
      const lastSend = user.timeOtp.getTime() - this.otpWindowMinutes * 60 * 1000;
      if ((now - lastSend) / 1000 < this.otpResendCooldownSec) {
        const remain = Math.ceil(this.otpResendCooldownSec - (now - lastSend) / 1000);
        throw new BadRequestException(`Vui lòng đợi ${remain}s trước khi yêu cầu lại OTP`);
      }
    }

    const otp = this.generateOtp();
    const otpHash = await this.hashPassword(otp);
    const expiresAt = new Date(Date.now() + this.otpWindowMinutes * 60 * 1000);

    await this.usersRepo.update({ id: user.id }, { otp: otpHash as any, timeOtp: expiresAt as any });

    if (byEmail) {
      await this.emailSvc.sendActivationCode(this.requireEmail(user), otp);
    } else {
      const phone = this.normalizePhone(this.requirePhone(user));
      if (!phone) throw new BadRequestException('SĐT không hợp lệ');
      await this.smsSvc.sendOtp(phone, otp);
    }

    return { sent: true, expiresAt };
  }

  async confirmAccountRecover(dto: AccountRecoverConfirmDto) {
    const raw = dto.email.trim();
    const byEmail = raw.includes('@');
    const value = byEmail ? raw.toLowerCase() : raw;
    if (byEmail && isFixedAdminEmail(value)) {
      throw new ForbiddenException('Không thể thay đổi tài khoản admin hệ thống');
    }

    const qb = this.usersRepo.createQueryBuilder('u').withDeleted();
    if (byEmail) qb.where('u.email = :v', { v: value });
    else {
      const phoneNorm = this.normalizePhone(value);
      qb.where('u.phone = :p1', { p1: value }).orWhere('u.phone = :p2', { p2: phoneNorm });
    }
    qb.addSelect(['u.otp', 'u.passwordHash']);

    const user = await qb.getOne();

    if (!user || !user.deletedAt) {
      throw new NotFoundException('Tài khoản không tồn tại hoặc không cần khôi phục');
    }

    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('confirmPassword phải trùng với newPassword');
    }

    if (!user.timeOtp || user.timeOtp.getTime() < Date.now()) {
      throw new BadRequestException('OTP đã hết hạn, vui lòng yêu cầu lại');
    }
    if (!user.otp) {
      throw new BadRequestException('OTP không hợp lệ, vui lòng yêu cầu lại');
    }

    const ok = await this.comparePassword(dto.otp, user.otp);
    if (!ok) throw new BadRequestException('OTP không đúng');

    const newHash = await this.hashPassword(dto.newPassword);

    await this.usersRepo.restore(user.id);
    await this.usersRepo.update(
      { id: user.id },
      { passwordHash: newHash as any, otp: null as any, timeOtp: null as any },
    );

    return { restored: true, passwordChanged: true };
  }

  // ========= Verify via access_token =========
  async requestVerifyForUser(userId: number, via?: 'email' | 'phone') {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Không tìm thấy người dùng');

    if (user.isVerified) {
      return { isVerified: true };
    }

    const preferred: 'email' | 'phone' = via ?? (user.email ? 'email' : 'phone');
    return this.sendVerifyOtp(user, preferred);
  }

  async verifyAccountForUser(userId: number, otpInput: string) {
    const user = await this.usersRepo
      .createQueryBuilder('u')
      .addSelect(['u.otp'])
      .where('u.id = :id', { id: userId })
      .getOne();

    if (!user) throw new NotFoundException('Không tìm thấy người dùng');

    if (user.isVerified) {
      return { isVerified: true };
    }

    if (!user.timeOtp || user.timeOtp.getTime() < Date.now()) {
      throw new BadRequestException('OTP đã hết hạn, vui lòng yêu cầu lại');
    }
    if (!user.otp) {
      throw new BadRequestException('OTP không hợp lệ, vui lòng yêu cầu lại');
    }

    const ok = await this.comparePassword(otpInput, user.otp);
    if (!ok) throw new BadRequestException('OTP không đúng');

    user.isVerified = true;
    user.otp = null as any;
    user.timeOtp = null as any;
    await this.usersRepo.save(user);

    return { verified: true };
  }
}
