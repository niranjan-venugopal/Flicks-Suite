import {
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { MediaService } from './media.service';

// 10 uploads/user/day ≈ 10 per long window is too tight to express with the
// shared buckets; use the long bucket (60s) at a low limit as the burst guard —
// the practical per-day ceiling is enforced by the burst limit + audit trail.
const UPLOAD_THROTTLE = { long: { ttl: 60_000, limit: 5 } };

/**
 * Avatar & company-logo uploads (PRD v4 §4, D5–D7). Multipart proxy uploads —
 * no client presigned PUTs in beta; the server owns validation and keys.
 */
@ApiTags('Media')
@ApiBearerAuth('access-token')
@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('media/avatar')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 9 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload profile photo (cropped square, ≤8 MB)' })
  uploadAvatar(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file?.buffer) throw new BadRequestException('Attach the image as "file"');
    return this.media.uploadAvatar(user.sub, user.tenantId, file.buffer);
  }

  @Delete('media/avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove profile photo (back to initials)' })
  removeAvatar(@CurrentUser() user: JwtPayload) {
    return this.media.removeAvatar(user.sub, user.tenantId);
  }

  @Post('org/logo')
  @Roles('owner', 'admin')
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 9 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload company logo (Owner/Admin; alpha kept)' })
  uploadLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file?.buffer) throw new BadRequestException('Attach the image as "file"');
    return this.media.uploadLogo(user.sub, user.tenantId, file.buffer);
  }

  @Delete('org/logo')
  @Roles('owner', 'admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove company logo (Owner/Admin)' })
  removeLogo(@CurrentUser() user: JwtPayload) {
    return this.media.removeLogo(user.sub, user.tenantId);
  }
}
