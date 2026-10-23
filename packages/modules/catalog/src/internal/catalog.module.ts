import { Module } from '@nestjs/common';
import { CollectionService } from './collection.service.js';
import { CollectionResolver } from './graphql/collection.resolver.js';
import { ProductMediaResolver } from './graphql/media.resolver.js';
import { ProductPartsResolver } from './graphql/product-parts.resolver.js';
import { ProductResolver } from './graphql/product.resolver.js';
import { ProductReviewResolver } from './graphql/reviews.resolver.js';
import { SizeChartResolver } from './graphql/size-chart.resolver.js';
import { SearchRuleResolver } from './graphql/search-rule.resolver.js';
import { SearchSynonymResolver } from './graphql/search-synonym.resolver.js';
import { BundleResolver } from './graphql/bundle.resolver.js';
import { BundleService } from './bundles.js';
import { ComplementService } from './complements.js';
import { PriceSaleService } from './price-sales.js';
import { ComplementResolver } from './graphql/complement.resolver.js';
import { ProductLabelResolver } from './graphql/product-label.resolver.js';
import { ProductLabelService } from './product-labels.js';
import { PersonalisationResolver } from './graphql/personalisation.resolver.js';
import { PersonalisationService } from './personalisation.js';
import { PriceSaleResolver } from './graphql/price-sale.resolver.js';
import { ProductScheduleResolver } from './graphql/schedule.resolver.js';
import { MediaService } from './media.service.js';
import { OptionService } from './option.service.js';
import { ProductExportService } from './product-export.service.js';
import { StockFileService } from './stock-file.service.js';
import { ProductImportService } from './product-import.service.js';
import { ProductService } from './product.service.js';
import { ProductReviewService } from './review.service.js';
import { StorefrontSearchController } from './search.controller.js';
import { SizeChartService } from './size-charts.js';
import { SearchRuleService } from './search-rules.js';
import { SearchSynonymService } from './search-synonyms.js';
import { VariantService } from './variant.service.js';
import { CopyDraftService } from './copy-drafts.service.js';
import { CopyDraftResolver } from './graphql/copy-draft.resolver.js';
import {
  CollectionMetafieldResolver,
  MetafieldResolver,
  ProductMetafieldResolver,
  VariantMetafieldResolver,
} from './graphql/metafield.resolver.js';
import { MetafieldService } from './metafields.js';

/**
 * Needs a {@link Database} provider from the host application, which also checks the storefront
 * key on the routes under /storefront/.
 */
@Module({
  providers: [
    ProductService,
    OptionService,
    VariantService,
    MediaService,
    CollectionService,
    ProductImportService,
    ProductExportService,
    StockFileService,
    ProductReviewService,
    SizeChartService,
    SearchRuleService,
    SearchSynonymService,
    BundleService,
    ComplementService,
    PersonalisationService,
    PriceSaleService,
    ProductResolver,
    ProductPartsResolver,
    ProductMediaResolver,
    CollectionResolver,
    ProductReviewResolver,
    SizeChartResolver,
    SearchRuleResolver,
    SearchSynonymResolver,
    BundleResolver,
    ComplementResolver,
    ProductLabelService,
    ProductLabelResolver,
    PersonalisationResolver,
    ProductScheduleResolver,
    PriceSaleResolver,
    CopyDraftService,
    CopyDraftResolver,
    MetafieldService,
    MetafieldResolver,
    ProductMetafieldResolver,
    VariantMetafieldResolver,
    CollectionMetafieldResolver,
  ],
  controllers: [StorefrontSearchController],
  exports: [
    ProductService,
    OptionService,
    VariantService,
    MediaService,
    CollectionService,
    ProductImportService,
    ProductExportService,
    StockFileService,
    ProductReviewService,
    SizeChartService,
    BundleService,
    ComplementService,
    PersonalisationService,
    PriceSaleService,
    MetafieldService,
  ],
})
export class CatalogModule {}
