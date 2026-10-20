import { ProductUpdateMutation } from '../api/operations';
import type { ProductDetail, ProductUpdateData } from '../api/types';
import { useLocale } from '../i18n/locale';
import { SearchListingCard } from '../online-store/search-listing';
import { useAdminMutation } from '../shell/shop-context';
import { problemText } from './product-form';

/**
 * The product's title and description for search engines, with how a search engine lists its
 * page at the shop's storefront (OS-09, ADR-600); blank, its own title and the start of its
 * description, as the storefront gives them (ADR-231).
 */
export function ProductSearchListing({
  product,
  storefront,
}: {
  product: Pick<ProductDetail, 'id' | 'handle' | 'title' | 'description' | 'seo'>;
  storefront: string;
}) {
  const { t } = useLocale();
  const update = useAdminMutation<
    ProductUpdateData,
    { input: { id: string; seo: { title: string; description: string } } }
  >(ProductUpdateMutation);
  return (
    <SearchListingCard
      url={`${storefront}/products/${product.handle}`}
      ownTitle={product.title}
      ownText={product.description}
      stored={product.seo ?? { title: null, description: null }}
      save={async (seo) => {
        const { productUpdate } = await update.mutateAsync({ input: { id: product.id, seo } });
        const error = productUpdate.userErrors[0];
        return error ? problemText(error, t) : null;
      }}
    />
  );
}
