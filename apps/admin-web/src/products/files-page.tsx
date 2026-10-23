import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, FileUp, Store } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  InventoryExportQuery,
  InventoryImportMutation,
  LocationsQuery,
  ProductsExportQuery,
  ProductsImportFromShopifyMutation,
  PagesImportFromShopifyMutation,
  BlogsImportFromShopifyMutation,
  CollectionsImportFromShopifyMutation,
  CustomersImportFromShopifyMutation,
  DiscountsImportFromShopifyMutation,
  ProductsImportMutation,
  UrlRedirectsImportFromShopifyMutation,
} from '../api/operations';
import type {
  FileRowError,
  InventoryExportData,
  InventoryImportData,
  InventoryImportResult,
  LocationsData,
  ProductsExportData,
  ProductsImportData,
  ProductsImportFromShopifyData,
  PagesImportFromShopifyData,
  PagesImportFromShopifyResult,
  BlogsImportFromShopifyData,
  BlogsImportFromShopifyResult,
  CollectionsImportFromShopifyData,
  CollectionsImportFromShopifyResult,
  CustomersImportFromShopifyData,
  CustomersImportFromShopifyResult,
  DiscountsImportFromShopifyData,
  DiscountsImportFromShopifyResult,
  ProductsImportResult,
  UrlRedirectsImportFromShopifyData,
  UrlRedirectsImportResult,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';
import { EDITS_MENUS } from '../online-store/menus';
import { MOVES_CUSTOMERS } from '../customers/transfer-page';
import { MANAGES_DISCOUNTS } from '../discounts/discounts-page';
import { WRITES_BLOGS, WRITES_PAGES } from '../online-store/pages';
import { EDITS_PRODUCTS } from './status';

/** A file the browser saves, as an export does. */
function save(csv: string, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The first rows of a file the core could not take, and how many there were in all. */
function RowErrors({ count, errors }: { count: number; errors: FileRowError[] }) {
  const { t } = useLocale();
  if (count === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count })}</span>
        {errors.slice(0, 5).map((error) => (
          <span key={`${error.row}-${error.column ?? ''}`}>
            {error.handle
              ? t('files.storeRowError', {
                  handle: error.handle,
                  column: error.column ?? '',
                  message: error.message,
                })
              : t('moving.rowError', {
                  row: error.row,
                  column: error.column ?? '',
                  message: error.message,
                })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** A CSV chosen from the phone or computer, read as text. */
function useChosenFile(onChosen: (file: { name: string; csv: string }) => void) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (chosen) void chosen.text().then((csv) => onChosen({ name: chosen.name, csv }));
  };
  return { input, onChange, choose: () => input.current?.click() };
}

/** How the owner's app reaches their store: a Dev Dashboard app's ID and secret, or a token. */
type StoreAccess = 'CLIENT' | 'TOKEN';

/**
 * Products straight from the owner's Shopify store, through its Admin API (ONB-05, ADR-749): its
 * address and their app's client ID and secret, or its access token, held by the page alone
 * while it is open; checked first, saying what it would make, update and leave, each problem by
 * its product's handle; then taken in at a tap.
 */
function ImportFromStore() {
  const { t } = useLocale();
  const shop = useShop();
  // The shop's redirects are theirs who edit its navigation (ADR-751).
  const editsRedirects = permits(shop, EDITS_MENUS);
  // And its pages theirs who write them (ADR-752).
  const writesPages = permits(shop, WRITES_PAGES);
  // And its blogs theirs who write those (ADR-753).
  const writesBlogs = permits(shop, WRITES_BLOGS);
  // And its customers theirs who may bring customers in (ADR-755).
  const movesCustomers = permits(shop, MOVES_CUSTOMERS);
  // And its discount codes theirs who make codes (ADR-756).
  const managesDiscounts = permits(shop, MANAGES_DISCOUNTS);
  type Store = { store: string; accessToken?: string; clientId?: string; clientSecret?: string };
  const run = useAdminMutation<
    ProductsImportFromShopifyData,
    Store & { dryRun: boolean; overwrite: boolean }
  >(ProductsImportFromShopifyMutation);
  const moveRedirects = useAdminMutation<
    UrlRedirectsImportFromShopifyData,
    Store & { dryRun: boolean }
  >(UrlRedirectsImportFromShopifyMutation);
  const movePages = useAdminMutation<PagesImportFromShopifyData, Store & { dryRun: boolean }>(
    PagesImportFromShopifyMutation,
  );
  const moveCollections = useAdminMutation<
    CollectionsImportFromShopifyData,
    Store & { dryRun: boolean }
  >(CollectionsImportFromShopifyMutation);
  const moveCustomers = useAdminMutation<
    CustomersImportFromShopifyData,
    Store & { dryRun: boolean }
  >(CustomersImportFromShopifyMutation);
  const moveDiscounts = useAdminMutation<
    DiscountsImportFromShopifyData,
    Store & { dryRun: boolean }
  >(DiscountsImportFromShopifyMutation);
  const moveBlogs = useAdminMutation<BlogsImportFromShopifyData, Store & { dryRun: boolean }>(
    BlogsImportFromShopifyMutation,
  );
  const { problem, attempt } = useAttempt();
  const [store, setStore] = useState('');
  const [access, setAccess] = useState<StoreAccess>('CLIENT');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [withCollections, setWithCollections] = useState(true);
  const [withRedirects, setWithRedirects] = useState(editsRedirects);
  const [withPages, setWithPages] = useState(writesPages);
  const [withBlogs, setWithBlogs] = useState(writesBlogs);
  const [withCustomers, setWithCustomers] = useState(movesCustomers);
  const [withDiscounts, setWithDiscounts] = useState(managesDiscounts);
  const [checked, setChecked] = useState<{
    products: ProductsImportResult;
    redirects: UrlRedirectsImportResult | null;
    pages: PagesImportFromShopifyResult | null;
    blogs: BlogsImportFromShopifyResult | null;
    collections: CollectionsImportFromShopifyResult | null;
    customers: CustomersImportFromShopifyResult | null;
    discounts: DiscountsImportFromShopifyResult | null;
  } | null>(null);
  const [done, setDone] = useState<{
    products: ProductsImportResult;
    redirects: UrlRedirectsImportResult | null;
    pages: PagesImportFromShopifyResult | null;
    blogs: BlogsImportFromShopifyResult | null;
    collections: CollectionsImportFromShopifyResult | null;
    customers: CustomersImportFromShopifyResult | null;
    discounts: DiscountsImportFromShopifyResult | null;
  } | null>(null);

  const given = (): Store => ({
    store,
    ...(access === 'TOKEN' ? { accessToken: token } : { clientId, clientSecret }),
  });
  /** The products, then the redirects, pages and blogs where asked for: null where any is refused. */
  const send = async (dryRun: boolean) => {
    const answer: {
      products?: ProductsImportResult;
      redirects?: UrlRedirectsImportResult;
      pages?: PagesImportFromShopifyResult;
      blogs?: BlogsImportFromShopifyResult;
      collections?: CollectionsImportFromShopifyResult;
      customers?: CustomersImportFromShopifyResult;
      discounts?: DiscountsImportFromShopifyResult;
    } = {};
    const ok = await attempt(async () => {
      answer.products = (
        await run.mutateAsync({ ...given(), dryRun, overwrite })
      ).productsImportFromShopify;
      return answer.products;
    });
    if (!ok) return null;
    // After the products, whose handles hand-picked collections name (ADR-754).
    if (withCollections) {
      const moved = await attempt(async () => {
        answer.collections = (
          await moveCollections.mutateAsync({ ...given(), dryRun })
        ).collectionsImportFromShopify;
        return answer.collections;
      });
      if (!moved) return null;
    }
    // After the products and collections, which codes are for (ADR-756).
    if (withDiscounts && managesDiscounts) {
      const moved = await attempt(async () => {
        answer.discounts = (
          await moveDiscounts.mutateAsync({ ...given(), dryRun })
        ).discountsImportFromShopify;
        return answer.discounts;
      });
      if (!moved) return null;
    }
    if (withRedirects && editsRedirects) {
      const moved = await attempt(async () => {
        answer.redirects = (
          await moveRedirects.mutateAsync({ ...given(), dryRun })
        ).urlRedirectsImportFromShopify;
        return answer.redirects;
      });
      if (!moved) return null;
    }
    if (withPages && writesPages) {
      const moved = await attempt(async () => {
        answer.pages = (await movePages.mutateAsync({ ...given(), dryRun })).pagesImportFromShopify;
        return answer.pages;
      });
      if (!moved) return null;
    }
    if (withBlogs && writesBlogs) {
      const moved = await attempt(async () => {
        answer.blogs = (await moveBlogs.mutateAsync({ ...given(), dryRun })).blogsImportFromShopify;
        return answer.blogs;
      });
      if (!moved) return null;
    }
    if (withCustomers && movesCustomers) {
      const moved = await attempt(async () => {
        answer.customers = (
          await moveCustomers.mutateAsync({ ...given(), dryRun })
        ).customersImportFromShopify;
        return answer.customers;
      });
      if (!moved) return null;
    }
    return {
      products: answer.products!,
      redirects: answer.redirects ?? null,
      pages: answer.pages ?? null,
      blogs: answer.blogs ?? null,
      collections: answer.collections ?? null,
      customers: answer.customers ?? null,
      discounts: answer.discounts ?? null,
    };
  };
  // What is checked is for the store and app as typed: a change asks for a new check.
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setChecked(null);
    };
  const ready =
    store.trim() !== '' &&
    (access === 'TOKEN'
      ? token.trim() !== ''
      : clientId.trim() !== '' && clientSecret.trim() !== '');
  const busy =
    run.isPending ||
    moveRedirects.isPending ||
    movePages.isPending ||
    moveBlogs.isPending ||
    moveCollections.isPending ||
    moveCustomers.isPending ||
    moveDiscounts.isPending;

  return (
    <FormSection title={t('files.fromStore')} hint={t('files.fromStoreHint')}>
      <TextField
        label={t('files.storeAddress')}
        value={store}
        ltr
        placeholder="zari.myshopify.com"
        autoComplete="off"
        onChange={(event) => changed(setStore)(event.target.value)}
      />
      <SelectField<StoreAccess>
        label={t('files.storeAccess')}
        value={access}
        options={[
          { value: 'CLIENT', label: t('files.storeClient') },
          { value: 'TOKEN', label: t('files.storeToken') },
        ]}
        onChange={changed(setAccess)}
      />
      {access === 'TOKEN' ? (
        <TextField
          label={t('files.accessToken')}
          type="password"
          value={token}
          ltr
          autoComplete="off"
          onChange={(event) => changed(setToken)(event.target.value)}
        />
      ) : (
        <>
          <TextField
            label={t('files.clientId')}
            value={clientId}
            ltr
            autoComplete="off"
            onChange={(event) => changed(setClientId)(event.target.value)}
          />
          <TextField
            label={t('files.clientSecret')}
            type="password"
            value={clientSecret}
            ltr
            autoComplete="off"
            onChange={(event) => changed(setClientSecret)(event.target.value)}
          />
        </>
      )}
      <CheckField
        label={t('files.storeOverwrite')}
        hint={t('files.storeOverwriteHint')}
        checked={overwrite}
        onChange={changed(setOverwrite)}
      />
      <CheckField
        label={t('files.storeCollections')}
        hint={t('files.storeCollectionsHint')}
        checked={withCollections}
        onChange={changed(setWithCollections)}
      />
      {editsRedirects && (
        <CheckField
          label={t('files.storeRedirects')}
          hint={t('files.storeRedirectsHint')}
          checked={withRedirects}
          onChange={changed(setWithRedirects)}
        />
      )}
      {writesPages && (
        <CheckField
          label={t('files.storePages')}
          hint={t('files.storePagesHint')}
          checked={withPages}
          onChange={changed(setWithPages)}
        />
      )}
      {writesBlogs && (
        <CheckField
          label={t('files.storeBlogs')}
          hint={t('files.storeBlogsHint')}
          checked={withBlogs}
          onChange={changed(setWithBlogs)}
        />
      )}
      {managesDiscounts && (
        <CheckField
          label={t('files.storeDiscounts')}
          hint={t('files.storeDiscountsHint')}
          checked={withDiscounts}
          onChange={changed(setWithDiscounts)}
        />
      )}
      {movesCustomers && (
        <CheckField
          label={t('files.storeCustomers')}
          hint={t('files.storeCustomersHint')}
          checked={withCustomers}
          onChange={changed(setWithCustomers)}
        />
      )}
      <Button
        variant="secondary"
        className="self-start"
        icon={<Store aria-hidden className="size-5" />}
        disabled={!ready}
        busy={busy && !checked}
        onClick={() => {
          setDone(null);
          void send(true).then(setChecked);
        }}
      >
        {t('files.checkStore')}
      </Button>
      {checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('files.storeChecked', {
              created: formatCount(checked.products.created),
              updated: formatCount(checked.products.updated),
              skipped: formatCount(checked.products.skipped),
              variants: formatCount(checked.products.variants),
            })}
          </p>
          <RowErrors count={checked.products.rowErrorCount} errors={checked.products.rowErrors} />
          {checked.collections && (
            <>
              <p>
                {t('files.collectionsChecked', {
                  created: formatCount(checked.collections.created),
                  skipped: formatCount(checked.collections.skipped),
                })}
              </p>
              <CollectionErrors result={checked.collections} />
            </>
          )}
          {checked.redirects && (
            <>
              <p>
                {t('files.redirectsChecked', {
                  created: formatCount(checked.redirects.created),
                  skipped: formatCount(checked.redirects.skipped),
                })}
              </p>
              <RedirectRowErrors result={checked.redirects} />
            </>
          )}
          {checked.pages && (
            <>
              <p>
                {t('files.pagesChecked', {
                  created: formatCount(checked.pages.created),
                  skipped: formatCount(checked.pages.skipped),
                })}
              </p>
              <PageErrors result={checked.pages} />
            </>
          )}
          {checked.blogs && (
            <>
              <p>
                {t('files.blogsChecked', {
                  blogs: formatCount(checked.blogs.blogsCreated),
                  created: formatCount(checked.blogs.created),
                  skipped: formatCount(checked.blogs.skipped),
                })}
              </p>
              <ArticleErrors result={checked.blogs} />
            </>
          )}
          {checked.discounts && (
            <>
              <p>
                {t('files.discountsChecked', {
                  created: formatCount(checked.discounts.created),
                  skipped: formatCount(checked.discounts.skipped),
                  expired: formatCount(checked.discounts.expired),
                })}
              </p>
              <DiscountErrors result={checked.discounts} />
            </>
          )}
          {checked.customers && (
            <>
              <p>
                {t('files.customersChecked', {
                  created: formatCount(checked.customers.created),
                  skipped: formatCount(checked.customers.skipped),
                })}
              </p>
              <CustomerErrors result={checked.customers} />
            </>
          )}
          {checked.products.created +
            checked.products.updated +
            (checked.collections?.created ?? 0) +
            (checked.redirects?.created ?? 0) +
            (checked.pages?.created ?? 0) +
            (checked.blogs?.blogsCreated ?? 0) +
            (checked.blogs?.created ?? 0) +
            (checked.customers?.created ?? 0) +
            (checked.discounts?.created ?? 0) >
            0 && (
            <Button
              className="self-start"
              busy={busy}
              onClick={() =>
                void send(false).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                    // Done with: the page keeps no credentials of the store's.
                    setToken('');
                    setClientSecret('');
                  }
                })
              }
            >
              {t('files.importProductsConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          <span className="flex flex-col gap-1">
            <span>
              {t('files.productsImported', {
                created: formatCount(done.products.created),
                updated: formatCount(done.products.updated),
                skipped: formatCount(done.products.skipped),
                images: formatCount(done.products.images),
                stocked: formatCount(done.products.stocked),
              })}
            </span>
            {done.collections && (
              <span>
                {t('files.collectionsImported', {
                  created: formatCount(done.collections.created),
                  images: formatCount(done.collections.images),
                  skipped: formatCount(done.collections.skipped),
                })}
              </span>
            )}
            {done.collections && done.collections.productsMissing > 0 && (
              <span>
                {t('files.collectionsMissing', {
                  count: formatCount(done.collections.productsMissing),
                })}
              </span>
            )}
            {done.redirects && (
              <span>
                {t('files.redirectsImported', {
                  created: formatCount(done.redirects.created),
                  skipped: formatCount(done.redirects.skipped),
                })}
              </span>
            )}
            {done.pages && (
              <span>
                {t('files.pagesImported', {
                  created: formatCount(done.pages.created),
                  skipped: formatCount(done.pages.skipped),
                })}
              </span>
            )}
            {done.blogs && (
              <span>
                {t('files.blogsImported', {
                  blogs: formatCount(done.blogs.blogsCreated),
                  created: formatCount(done.blogs.created),
                  images: formatCount(done.blogs.images),
                  skipped: formatCount(done.blogs.skipped),
                })}
              </span>
            )}
            {done.discounts && (
              <span>
                {t('files.discountsImported', {
                  created: formatCount(done.discounts.created),
                  skipped: formatCount(done.discounts.skipped),
                })}
              </span>
            )}
            {done.customers && (
              <span>
                {t('files.customersImported', {
                  created: formatCount(done.customers.created),
                  skipped: formatCount(done.customers.skipped),
                  addresses: formatCount(done.customers.addresses),
                })}
              </span>
            )}
            {done.customers?.addressErrors.slice(0, 5).map((error, index) => (
              <span key={`address-${index}`}>
                {t('files.customerError', { customer: error.customer, message: error.message })}
              </span>
            ))}
          </span>
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** A store's discounts the shop could not take, or not whole, each by its title. */
function DiscountErrors({ result }: { result: DiscountsImportFromShopifyResult }) {
  const { t } = useLocale();
  if (result.discountErrors.length === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count: result.discountErrors.length })}</span>
        {result.discountErrors.slice(0, 5).map((error, index) => (
          <span key={index}>
            {t('files.discountError', { discount: error.discount, message: error.message })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** A store's customers the shop could not take, each by their name, and those with no number. */
function CustomerErrors({ result }: { result: CustomersImportFromShopifyResult }) {
  const { t } = useLocale();
  if (result.customerErrorCount === 0 && result.withoutPhone === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        {result.withoutPhone > 0 && (
          <span>
            {t('files.customersWithoutPhone', { count: formatCount(result.withoutPhone) })}
          </span>
        )}
        {result.customerErrorCount > 0 && (
          <span>{t('moving.rowErrors', { count: result.customerErrorCount })}</span>
        )}
        {result.customerErrors.slice(0, 5).map((error, index) => (
          <span key={index}>
            {t('files.customerError', { customer: error.customer, message: error.message })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** A store's collections the shop could not take, each by its handle. */
function CollectionErrors({ result }: { result: CollectionsImportFromShopifyResult }) {
  const { t } = useLocale();
  if (result.collectionErrors.length === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count: result.collectionErrors.length })}</span>
        {result.collectionErrors.slice(0, 5).map((error) => (
          <span key={error.handle}>
            {t('files.collectionError', { handle: error.handle, message: error.message })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** A store's articles, or whole blogs, the shop could not take, each by its blog's handle. */
function ArticleErrors({ result }: { result: BlogsImportFromShopifyResult }) {
  const { t } = useLocale();
  if (result.articleErrors.length === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count: result.articleErrors.length })}</span>
        {result.articleErrors.slice(0, 5).map((error) => {
          const handle = error.article ? `${error.blog}/${error.article}` : error.blog;
          return (
            <span key={handle}>{t('files.articleError', { handle, message: error.message })}</span>
          );
        })}
      </span>
    </Alert>
  );
}

/** A store's pages the shop could not take, each by its handle. */
function PageErrors({ result }: { result: PagesImportFromShopifyResult }) {
  const { t } = useLocale();
  if (result.pageErrors.length === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count: result.pageErrors.length })}</span>
        {result.pageErrors.slice(0, 5).map((error) => (
          <span key={error.handle}>
            {t('files.pageError', { handle: error.handle, message: error.message })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** The first of a store's redirects the shop could not take, each by its path. */
function RedirectRowErrors({ result }: { result: UrlRedirectsImportResult }) {
  const { t } = useLocale();
  if (result.rowErrorCount === 0) return null;
  return (
    <Alert tone="warning">
      <span className="flex flex-col gap-1">
        <span>{t('moving.rowErrors', { count: result.rowErrorCount })}</span>
        {result.rowErrors.slice(0, 5).map((error) => (
          <span key={error.row}>
            {t('files.redirectRowError', { path: error.path ?? '', message: error.message })}
          </span>
        ))}
      </span>
    </Alert>
  );
}

/** Whose product export a file is (ADR-482). */
type ImportFormat = 'SHOPIFY' | 'WOOCOMMERCE' | 'INSTAGRAM';

/**
 * Products from Shopify's or WooCommerce's product CSV (ONB-05, ONB-06, CAT-05), or a shop's
 * Instagram posts as drafts (ONB-04, ADR-501): checked first,
 * saying what it would make,
 * update and leave and what it could not read; then taken in at a tap. Products the shop has
 * already are left as they are unless staff ask to update them from the file.
 */
function ImportProducts() {
  const { t } = useLocale();
  const run = useAdminMutation<
    ProductsImportData,
    { csv: string; dryRun: boolean; overwrite: boolean; format: ImportFormat }
  >(ProductsImportMutation);
  const { problem, attempt } = useAttempt();
  const [overwrite, setOverwrite] = useState(false);
  const [format, setFormat] = useState<ImportFormat>('SHOPIFY');
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<ProductsImportResult | null>(null);
  const [done, setDone] = useState<ProductsImportResult | null>(null);

  const send = async (csv: string, dryRun: boolean, update: boolean, from = format) => {
    const answer: { value?: ProductsImportResult } = {};
    const ok = await attempt(async () => {
      answer.value = (
        await run.mutateAsync({ csv, dryRun, overwrite: update, format: from })
      ).productsImport;
      return answer.value;
    });
    return ok ? answer.value! : null;
  };

  const check = async (
    chosen: { name: string; csv: string },
    update: boolean,
    from: ImportFormat = format,
  ) => {
    setDone(null);
    setChecked(null);
    setFile(chosen);
    setChecked(await send(chosen.csv, true, update, from));
  };
  const picker = useChosenFile((chosen) => void check(chosen, overwrite));

  return (
    <FormSection title={t('files.importProducts')} hint={t('files.importProductsHint')}>
      <SelectField<ImportFormat>
        label={t('files.importFrom')}
        value={format}
        options={[
          { value: 'SHOPIFY', label: t('files.fromShopify') },
          { value: 'WOOCOMMERCE', label: t('files.fromWooCommerce') },
          { value: 'INSTAGRAM', label: t('files.fromInstagram') },
        ]}
        onChange={(next) => {
          setFormat(next);
          if (file && !done) void check(file, overwrite, next);
        }}
      />
      {format === 'INSTAGRAM' && (
        <p className="text-sm text-secondary">{t('files.instagramHint')}</p>
      )}
      <CheckField
        label={t('files.overwrite')}
        hint={t('files.overwriteHint')}
        checked={overwrite}
        onChange={(next) => {
          setOverwrite(next);
          if (file && !done) void check(file, next);
        }}
      />
      <Button
        variant="secondary"
        className="self-start"
        icon={<FileUp aria-hidden className="size-5" />}
        busy={run.isPending && !checked}
        onClick={picker.choose}
      >
        {t('files.choose')}
      </Button>
      <input
        ref={picker.input}
        type="file"
        accept={format === 'INSTAGRAM' ? '.json,application/json' : '.csv,text/csv'}
        className="hidden"
        aria-label={t('files.productsFile')}
        onChange={picker.onChange}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('files.productsChecked', {
              name: file.name,
              rows: formatCount(checked.rows),
              created: formatCount(checked.created),
              updated: formatCount(checked.updated),
              skipped: formatCount(checked.skipped),
              variants: formatCount(checked.variants),
            })}
          </p>
          <RowErrors count={checked.rowErrorCount} errors={checked.rowErrors} />
          {checked.created + checked.updated > 0 && (
            <Button
              className="self-start"
              busy={run.isPending}
              onClick={() =>
                void send(file.csv, false, overwrite).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                  }
                })
              }
            >
              {t('files.importProductsConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('files.productsImported', {
            created: formatCount(done.created),
            updated: formatCount(done.updated),
            skipped: formatCount(done.skipped),
            images: formatCount(done.images),
            stocked: formatCount(done.stocked),
          })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** The shop's products as Shopify's product CSV: all of them, or those a search finds. */
function ExportProducts() {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ products: number; rows: number } | null>(null);
  const exporting = useAdminQuery<ProductsExportData>(
    ['productsExport', words.trim()],
    ProductsExportQuery,
    { query: words.trim() || null },
    { enabled: false },
  );

  const download = async () => {
    setProblem(null);
    setDone(null);
    const { data, error } = await exporting.refetch();
    if (!data) {
      setProblem(errorText(error, t));
      return;
    }
    save(data.productsExport.csv, 'products_export.csv');
    setDone({ products: data.productsExport.productCount, rows: data.productsExport.rowCount });
  };

  return (
    <FormSection title={t('files.exportProducts')} hint={t('files.exportProductsHint')}>
      <div className="flex flex-col gap-1">
        <label htmlFor="export-products" className="font-medium">
          {t('files.which')}
        </label>
        <input
          id="export-products"
          type="search"
          dir="auto"
          placeholder={t('files.whichPlaceholder')}
          value={words}
          onChange={(event) => setWords(event.target.value)}
          className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && (
        <Alert tone="success">
          {t('files.productsExported', {
            products: formatCount(done.products),
            rows: formatCount(done.rows),
          })}
        </Alert>
      )}
      <Button
        variant="secondary"
        className="self-start"
        icon={<Download aria-hidden className="size-5" />}
        busy={exporting.isFetching}
        onClick={() => void download()}
      >
        {t('files.downloadProducts')}
      </Button>
    </FormSection>
  );
}

/**
 * A stock count by file (CAT-05): the shop's stock as Shopify's inventory CSV, at one location or
 * all, to fill On hand (new) in a spreadsheet; then the file checked, saying what it would count,
 * leave and could not read, and counted at a tap. Stock that sold since the file was saved is
 * not counted over.
 */
function StockCount() {
  const { t } = useLocale();
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const [locationId, setLocationId] = useState('');
  const [exportProblem, setExportProblem] = useState<string | null>(null);
  const [exported, setExported] = useState<number | null>(null);
  const exporting = useAdminQuery<InventoryExportData>(
    ['inventoryExport', locationId],
    InventoryExportQuery,
    { locationId: locationId || null },
    { enabled: false },
  );
  const run = useAdminMutation<InventoryImportData, { csv: string; dryRun: boolean }>(
    InventoryImportMutation,
  );
  const { problem, attempt } = useAttempt();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [checked, setChecked] = useState<InventoryImportResult | null>(null);
  const [done, setDone] = useState<InventoryImportResult | null>(null);

  const send = async (csv: string, dryRun: boolean) => {
    const answer: { value?: InventoryImportResult } = {};
    const ok = await attempt(async () => {
      answer.value = (await run.mutateAsync({ csv, dryRun })).inventoryImport;
      return answer.value;
    });
    return ok ? answer.value! : null;
  };
  const picker = useChosenFile((chosen) => {
    setDone(null);
    setChecked(null);
    setFile(chosen);
    void send(chosen.csv, true).then(setChecked);
  });

  const download = async () => {
    setExportProblem(null);
    setExported(null);
    const { data, error } = await exporting.refetch();
    if (!data) {
      setExportProblem(errorText(error, t));
      return;
    }
    save(data.inventoryExport.csv, 'inventory_export.csv');
    setExported(data.inventoryExport.rowCount);
  };

  return (
    <FormSection title={t('files.stock')} hint={t('files.stockHint')}>
      <SelectField
        label={t('files.location')}
        value={locationId}
        options={[
          { value: '', label: t('files.everyLocation') },
          ...(locations.data?.locations.nodes ?? []).map((location) => ({
            value: location.id,
            label: location.name,
          })),
        ]}
        onChange={setLocationId}
      />
      {exportProblem && <Alert tone="danger">{exportProblem}</Alert>}
      {exported !== null && (
        <Alert tone="success">{t('files.stockExported', { rows: formatCount(exported) })}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<Download aria-hidden className="size-5" />}
          busy={exporting.isFetching}
          onClick={() => void download()}
        >
          {t('files.downloadStock')}
        </Button>
        <Button
          variant="secondary"
          icon={<FileUp aria-hidden className="size-5" />}
          busy={run.isPending && !checked}
          onClick={picker.choose}
        >
          {t('files.chooseCount')}
        </Button>
      </div>
      <input
        ref={picker.input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        aria-label={t('files.stockFile')}
        onChange={picker.onChange}
      />
      {file && checked && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {t('files.stockChecked', {
              name: file.name,
              rows: formatCount(checked.rows),
              counted: formatCount(checked.counted),
              unchanged: formatCount(checked.unchanged),
            })}
          </p>
          <RowErrors count={checked.rowErrorCount} errors={checked.rowErrors} />
          {checked.counted > 0 && (
            <Button
              className="self-start"
              busy={run.isPending}
              onClick={() =>
                void send(file.csv, false).then((result) => {
                  if (result) {
                    setDone(result);
                    setChecked(null);
                  }
                })
              }
            >
              {t('files.countConfirm')}
            </Button>
          )}
        </div>
      )}
      {done && (
        <Alert tone="success">
          {t('files.counted', {
            counted: formatCount(done.counted),
            unchanged: formatCount(done.unchanged),
          })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/**
 * Products and stock in and out of Hatti, from a Shopify store or by file (CAT-05, ONB-05), for
 * owners and managers.
 */
export function ProductFilesPage() {
  const { t } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  if (!permits(shop, EDITS_PRODUCTS)) return <EmptyState title={t('files.cannot')} />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/products"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('products.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('files.title')}
      </h1>
      <ImportFromStore />
      <ImportProducts />
      <ExportProducts />
      <StockCount />
    </div>
  );
}
