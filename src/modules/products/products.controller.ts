import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  ParseIntPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { Express } from 'express';
import { cloudinary } from '../../config/cloudinary.config';

import { Public } from '../../common/decorators/public.decorator';

import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { QueryProductsDto } from './dto/query-products.dto';

import { AccessTokenGuard } from '../../common/guards/access-token.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../modules/users/entities/user.entity';
import { UpdateProductDto } from './dto/search-product.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { AppRole } from 'src/common/constants/roles';

// ==== cấu hình upload nhiều ảnh (vẫn lưu vào uploads/products) ====
const uploadOptions: MulterOptions = {
  storage: diskStorage({
    destination: (req, file, cb) => {
      const dir = join(process.cwd(), 'uploads', 'products');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${randomBytes(6).toString('hex')}`;
      cb(null, unique + extname(file.originalname).toLowerCase());
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      return cb(new BadRequestException('Chỉ chấp nhận ảnh (jpeg, png, webp, gif)'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
};

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ===== public list/detail =====
  @Public()
  @Get()
  async list(@Query() q: QueryProductsDto) {
    const data = await this.productsService.findPublic(q);
    return { success: true, data };
  }

  @Get('by-shop/:shopId')
  async listByShop(
    @Param('shopId', ParseIntPipe) shopId: number,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const data = await this.productsService.findByShop(shopId, Number(page), Number(limit));
    return { success: true, data };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const data = await this.productsService.findOnePublic(Number(id));
    return { success: true, data };
  }

  @Roles(AppRole.ADMIN, AppRole.SELLER)
  @Post()
  @UseInterceptors(FilesInterceptor('images', 10, uploadOptions))
  async create(
    @CurrentUser('sub') userId: number,
    @Body() dto: CreateProductDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request, // không dùng nữa nhưng giữ cho đỡ phải sửa signature ở chỗ khác
  ) {
    // 1) Multer đã lưu file vào uploads/products
    // 2) Ta lấy đường dẫn local đó để upload lên Cloudinary
    const cloudinaryUrls: string[] = [];

    if (files && files.length > 0) {
      const uploadResults = await Promise.all(
        files.map((file) =>
          cloudinary.uploader.upload((file as any).path, {
            folder: 'mini-e/products', // bạn có thể đổi tên folder trên Cloudinary nếu muốn
          }),
        ),
      );

      uploadResults.forEach((res) => {
        cloudinaryUrls.push(res.secure_url); // URL cuối cùng dùng để lưu DB
      });
    }

    const product = await this.productsService.createBySeller(userId, {
      ...dto,
      // ưu tiên dùng URL từ Cloudinary; nếu không có file upload thì fallback sang dto.images (nếu FE gửi sẵn)
      images: cloudinaryUrls.length ? cloudinaryUrls : dto.images,
    });

    return { success: true, data: product };
  }
  @Roles(AppRole.ADMIN, AppRole.SELLER)
  @Patch(':id')
  async updateProduct(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('sub') userId: number,
    @CurrentUser('role') role: UserRole,
    @Body() dto: UpdateProductDto,
  ) {
    const data = await this.productsService.updateProduct(id, userId, role, dto);
    return { success: true, data };
  }
  @Roles(AppRole.ADMIN, AppRole.SELLER)
  @Delete(':id')
  async removeProduct(
    @Param('id') id: string,
    @CurrentUser('sub') userId: number,
    @CurrentUser('role') role: UserRole,
  ) {
    const res = await this.productsService.removeProduct(Number(id), userId, role);
    return { res };
  }

  @Roles(AppRole.ADMIN, AppRole.SELLER)
  @Post(':id/variants/generate')
  async generateVariants(
    @Param('id') id: string,
    @CurrentUser('sub') userId: number,
    @CurrentUser('role') role: UserRole,
    @Body() dto: GenerateVariantsDto,
  ) {
    const data = await this.productsService.generateVariants(Number(id), userId, role, dto);
    return { success: true, data };
  }


  @Get(':id/variants')
  async listVariants(
    @Param('id') id: string,
    @CurrentUser('sub') userId: number,
    @CurrentUser('role') role: UserRole,
  ) {
    const data = await this.productsService.listVariants(Number(id), userId, role);
    return { success: true, data };
  }

  @Roles(AppRole.ADMIN, AppRole.SELLER)
  @Patch(':productId/variants/:variantId')
  async updateVariant(
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @CurrentUser('sub') userId: number,
    @CurrentUser('role') role: UserRole,
    @Body() dto: UpdateVariantDto,
  ) {
    const data = await this.productsService.updateVariant(
      Number(productId),
      Number(variantId),
      userId,
      role,
      dto,
    );
    return { success: true, data };
  }
}
