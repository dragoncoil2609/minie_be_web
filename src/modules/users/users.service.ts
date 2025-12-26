// users.service.ts
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  FIXED_ADMIN_EMAIL,
  FIXED_ADMIN_NAME,
  FIXED_ADMIN_PASSWORD,
  isFixedAdminEmail,
} from 'src/common/constants/fixed-admin';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.ensureFixedAdmin();
  }

  private isUniqueViolation(e: any) {
    return (
      e?.code === 'ER_DUP_ENTRY' ||
      e?.code === '23505' ||
      /unique/i.test(e?.message ?? '')
    );
  }

  private normalizeEmail(email?: string) {
    const v = (email ?? '').trim();
    return v ? v.toLowerCase() : undefined;
  }

  private async hashPassword(raw: string) {
    const rounds = Number(this.config.get('BCRYPT_SALT_ROUNDS') ?? 12);
    const pepper = this.config.get<string>('BCRYPT_PEPPER');
    const toHash = pepper ? raw + pepper : raw;
    return bcrypt.hash(toHash, rounds);
  }

  private async ensureFixedAdmin() {
    const email = FIXED_ADMIN_EMAIL;
    const passwordHash = await this.hashPassword(FIXED_ADMIN_PASSWORD);

    const existed = await this.repo.findOne({
      where: { email },
      withDeleted: true,
    });

    if (!existed) {
      const entity = this.repo.create({
        name: FIXED_ADMIN_NAME,
        email,
        passwordHash,
        role: UserRole.ADMIN,
        isVerified: true,
        otp: null as any,
        timeOtp: null as any,
        phone: null as any,
        avatarUrl: null as any,
        birthday: null as any,
        gender: null as any,
      } as DeepPartial<User>);

      await this.repo.save(entity);
      this.logger.log(`Seeded fixed admin: ${email}`);
      return;
    }

    if (existed.deletedAt) {
      await this.repo.restore(existed.id);
    }

    await this.repo.update(
      { id: existed.id },
      {
        name: FIXED_ADMIN_NAME,
        email,
        passwordHash,
        role: UserRole.ADMIN,
        isVerified: true,
        otp: null as any,
        timeOtp: null as any,
        phone: null as any,
        avatarUrl: null as any,
        birthday: null as any,
        gender: null as any,
      } as any,
    );
  }

  // VN normalize giống phần auth
  private normalizePhone(phone?: string) {
    const raw = (phone ?? '').trim();
    if (!raw) return undefined;

    if (/^\+\d{8,15}$/.test(raw)) return raw;
    if (/^84\d{8,15}$/.test(raw)) return `+${raw}`;
    if (/^0\d{9,10}$/.test(raw)) return `+84${raw.slice(1)}`;

    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

    throw new BadRequestException('Số điện thoại không hợp lệ');
  }

  async create(dto: CreateUserDto): Promise<User> {
    const email = this.normalizeEmail(dto.email);
    const phone = this.normalizePhone(dto.phone);

    if (email && isFixedAdminEmail(email)) {
      throw new ConflictException('Email đã tồn tại');
    }

    // Nếu DTO của bạn bắt buộc email thì đoạn này không cần,
    // nhưng để đồng bộ hệ thống (email/phone có thể thiếu) thì giữ lại:
    if (!email && !phone) {
      throw new BadRequestException('Phải nhập email hoặc số điện thoại');
    }

    // Check trùng email
    if (email) {
      const exists = await this.repo.findOne({
        where: { email },
        withDeleted: true,
      });
      if (exists && !exists.deletedAt) throw new ConflictException('Email đã tồn tại');
    }

    // Check trùng phone
    if (phone) {
      const existsPhone = await this.repo.findOne({
        where: { phone } as any,
        withDeleted: true,
      });
      if (existsPhone && !existsPhone.deletedAt)
        throw new ConflictException('Số điện thoại đã tồn tại');
    }

    const passwordHash = await this.hashPassword(dto.password);

    // ✅ Quan trọng: DeepPartial<User> để TS không match nhầm overload array
    const data: DeepPartial<User> = {
      name: dto.name.trim(),
      email, // undefined nếu rỗng
      phone, // undefined nếu rỗng
      passwordHash,
      avatarUrl: dto.avatarUrl?.trim() || undefined,
      birthday: dto.birthday ?? undefined,
      gender: dto.gender ?? undefined,
      isVerified: dto.isVerified ?? false,
      role: dto.role ?? UserRole.USER,
    };

    const entity = this.repo.create(data);

    try {
      const saved = await this.repo.save(entity);
      return this.repo.findOneByOrFail({ id: saved.id }); // không lộ passwordHash
    } catch (e: any) {
      if (this.isUniqueViolation(e)) {
        // MySQL duplicate message thường có key name -> map gọn
        const msg = String(e?.message ?? '');
        if (/phone/i.test(msg)) throw new ConflictException('Số điện thoại đã tồn tại');
        throw new ConflictException('Email đã tồn tại');
      }
      throw e;
    }
  }

  async findById(id: number): Promise<User> {
    // Mặc định KHÔNG trả bản ghi đã xoá mềm
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User không tồn tại');
    return user;
  }

  async findAll(q: QueryUserDto) {
    const page = Math.max(Number(q.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const qb = this.repo.createQueryBuilder('u'); // mặc định không include deleted

    // search by name / email / phone
    if (q.search) {
      const kw = `%${q.search}%`;
      qb.andWhere('(u.name LIKE :kw OR u.email LIKE :kw OR u.phone LIKE :kw)', {
        kw,
      });
    }

    const sortBy = q.sortBy ?? 'createdAt';
    const sortOrder = (q.sortOrder ?? 'DESC').toUpperCase() as 'ASC' | 'DESC';

    // chống sortBy bậy (tránh SQL injection)
    const allowSort = new Set([
      'id',
      'name',
      'email',
      'phone',
      'role',
      'isVerified',
      'createdAt',
      'updatedAt',
      'lastLoginAt',
    ]);
    const safeSortBy = allowSort.has(sortBy) ? sortBy : 'createdAt';

    qb.orderBy(`u.${safeSortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: { page, limit, total, pageCount: Math.max(Math.ceil(total / limit), 1) },
    };
  }

  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findById(id); // nếu đã xoá mềm sẽ ném NotFound

    if (isFixedAdminEmail(user.email)) {
      throw new ForbiddenException('Không thể chỉnh sửa tài khoản admin hệ thống');
    }

    if ((dto as any).email !== undefined) {
      const e = this.normalizeEmail(String((dto as any).email));
      (dto as any).email = e; // có thể undefined => set về NULL? (ở đây giữ undefined để không đổi)
    }

    if ((dto as any).phone !== undefined) {
      const p = this.normalizePhone(String((dto as any).phone));
      (dto as any).phone = p;
    }

    if (dto.password) {
      (user as any).passwordHash = await this.hashPassword(dto.password);
      delete (dto as any).password;
    }

    Object.assign(user, dto);

    try {
      await this.repo.save(user);
      return this.findById(id);
    } catch (e: any) {
      if (this.isUniqueViolation(e)) {
        const msg = String(e?.message ?? '');
        if (/phone/i.test(msg)) throw new ConflictException('Số điện thoại đã tồn tại');
        throw new ConflictException('Email đã tồn tại');
      }
      throw e;
    }
  }

  // 🔧 Soft delete có kiểm tra trạng thái
  async softDelete(id: number): Promise<void> {
    // Tìm cả đã xoá để biết tình trạng
    const existed = await this.repo.findOne({ where: { id }, withDeleted: true });
    if (!existed) throw new NotFoundException('User không tồn tại');

    if (isFixedAdminEmail(existed.email)) {
      throw new ForbiddenException('Không thể xoá tài khoản admin hệ thống');
    }

    // Nếu đã xoá mềm trước đó → coi như “không tồn tại”
    if (existed.deletedAt) throw new NotFoundException('User không tồn tại');

    const res = await this.repo.softDelete(id);
    if (!res.affected) throw new NotFoundException('User không tồn tại');
  }

  // 🔧 Restore có kiểm tra trạng thái
  async restore(id: number): Promise<void> {
    const existed = await this.repo.findOne({ where: { id }, withDeleted: true });
    if (!existed) throw new NotFoundException('User không tồn tại');
    if (isFixedAdminEmail(existed.email)) {
      throw new ForbiddenException('Không thể thay đổi tài khoản admin hệ thống');
    }
    if (!existed.deletedAt) return; // idempotent

    const res = await this.repo.restore(id);
    if (!res.affected) throw new NotFoundException('User không tồn tại');
  }

  async hardDelete(id: number): Promise<void> {
    const existed = await this.repo.findOne({ where: { id }, withDeleted: true });
    if (existed && isFixedAdminEmail(existed.email)) {
      throw new ForbiddenException('Không thể xoá tài khoản admin hệ thống');
    }
    const res = await this.repo.delete(id);
    if (!res.affected) throw new NotFoundException('User không tồn tại');
  }

  async findAllDeleted(q: QueryUserDto) {
    const page = Math.max(Number(q.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);

    const qb = this.repo
      .createQueryBuilder('u')
      .withDeleted()
      .where('u.deletedAt IS NOT NULL'); // chỉ lấy bản ghi đã xoá

    if (q.search) {
      const kw = `%${q.search}%`;
      qb.andWhere('(u.name LIKE :kw OR u.email LIKE :kw OR u.phone LIKE :kw)', { kw });
    }

    const sortBy = q.sortBy ?? 'deletedAt';
    const sortOrder = (q.sortOrder ?? 'DESC').toUpperCase() as 'ASC' | 'DESC';

    const allowSort = new Set(['deletedAt', 'createdAt', 'updatedAt', 'id', 'name', 'email', 'phone']);
    const safeSortBy = allowSort.has(sortBy) ? sortBy : 'deletedAt';

    qb.orderBy(`u.${safeSortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: { page, limit, total, pageCount: Math.max(Math.ceil(total / limit), 1) },
    };
  }

  // Mặc định: 30 ngày
  private graceDays() {
    return Number(this.config.get('ACCOUNT_DELETE_GRACE_DAYS') ?? 30);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM) // chạy 03:00 mỗi ngày
  async hardDeleteExpired() {
    const days = this.graceDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    await this.repo
      .createQueryBuilder()
      .delete()
      .from(User)
      .where('deletedAt IS NOT NULL AND deletedAt < :cutoff AND (email IS NULL OR email <> :adminEmail)', {
        cutoff,
        adminEmail: FIXED_ADMIN_EMAIL,
      })
      .execute();
  }
}
