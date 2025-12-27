import { Body, Controller, Delete, Get, Param, Patch, Post, Query, ParseIntPipe } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { SearchCategoriesDto } from './dto/search-categories.dto';
import { AppRole } from 'src/common/constants/roles';
import { Roles } from 'src/common/decorators/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // ===== public =====
  @Public()
  @Get()
  async list(@Query() q: SearchCategoriesDto) {
    const data = await this.categoriesService.findAllPublic(q);
    return { success: true, data };
  }

  @Public()
  @Get('tree')
  async tree() {
    const data = await this.categoriesService.findTreePublic();
    return { success: true, data };
  }

  @Public()
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const data = await this.categoriesService.findOnePublic(id);
    return { success: true, data };
  }

  // ===== admin =====
  @Roles(AppRole.ADMIN)
  @Post()
  async create(
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreateCategoryDto,
  ) {
    const data = await this.categoriesService.create(role, dto);
    return { success: true, data };
  }
  @Roles(AppRole.ADMIN)
  @Patch(':id')
  async update(
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ) {
    const data = await this.categoriesService.update(role, id, dto);
    return { success: true, data };
  }
  @Roles(AppRole.ADMIN)
  @Delete(':id')
  async remove(
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const data = await this.categoriesService.remove(role, id);
    return { success: true, data };
  }
}
