import {
  commentsPath,
  type CommentErrorResponse,
  type CommentResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CommentService } from './comment.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Comments shoppers post from an article's page, as storefronts send them on (ADR-220):
 * `POST /storefront/shops/{shop}/comments` with the article's `blog` and `article` handles, the
 * form's `author`, `email` and `body`, and where it came from. 422 says what was wrong with it.
 * The host application checks the storefront key before any of this runs.
 */
@Controller(commentsPath(':shopId').slice(1))
export class StorefrontCommentsController {
  constructor(private readonly comments: CommentService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async post(@Param('shopId') shopId: string, @Body() body: unknown): Promise<CommentResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '');
    const result = await this.comments.post(shopId, {
      blog: text('blog'),
      article: text('article'),
      author: text('author'),
      email: text('email'),
      body: text('body'),
      ip: text('ip') || null,
      userAgent: text('userAgent') || null,
    });
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies CommentErrorResponse);
    }
    return { status: result.value.status === 'published' ? 'published' : 'pending' };
  }
}
