import Link from 'next/link';
import { redirect } from 'next/navigation';
import { customerToken } from '@/app/account/actions';
import { deleteAddress, makeDefault, saveAddress } from '@/app/account/addresses/actions';
import { ADDRESS_FIELDS, PROVINCES, type AddressField } from '@/lib/addresses';
import { storefront } from '@/lib/hatti';
import { languageOf } from '@/lib/language';
import { CUSTOMER_ADDRESSES_QUERY } from '@/lib/queries';
import type { MailingAddress } from '@/lib/types';
import { wordsOf, type Words } from '@/lib/words';

export const metadata = { title: 'Addresses' };

/** The form's field, or what the API refused, in the shopper's language. */
const labelOf = (field: AddressField, words: Words) => words[field];

/** An address's form: a new one, or the one it changes. */
function AddressForm({ address, words }: { address?: MailingAddress; words: Words }) {
  return (
    <form action={saveAddress} className="address-form">
      {address && <input type="hidden" name="id" value={address.id} />}
      {ADDRESS_FIELDS.map((field) =>
        field === 'province' ? (
          <label key={field}>
            {words.province}
            <select name="province" defaultValue={address?.province ?? 'Punjab'}>
              {PROVINCES.map((province) => (
                <option key={province} value={province}>
                  {province}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={field}>
            {labelOf(field, words)}
            <input
              name={field}
              defaultValue={address?.[field] ?? ''}
              required={['firstName', 'phone', 'address1', 'city'].includes(field)}
              maxLength={field === 'zip' ? 10 : 120}
              dir={field === 'phone' || field === 'zip' ? 'ltr' : 'auto'}
              {...(field === 'phone' && { type: 'tel', autoComplete: 'tel' })}
            />
          </label>
        ),
      )}
      <button type="submit">{words.saveAddress}</button>
      {address && <Link href="/account/addresses">{words.cancel}</Link>}
    </form>
  );
}

// The shopper's address book (ADR-947): each address, the one delivered to first marked, to change,
// deliver to first or take out, and a form to add one; through the Storefront API (ADR-946).
export default async function AddressesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const token = await customerToken();
  if (!token) redirect('/account/login');
  const { customer } = await storefront<{
    customer: {
      defaultAddress: { id: string } | null;
      addresses: { nodes: MailingAddress[] };
    } | null;
  }>(CUSTOMER_ADDRESSES_QUERY, { customerAccessToken: token }, { cache: 'none' });
  if (!customer) redirect('/account/login');
  const { edit, error } = await searchParams;
  const words = wordsOf(await languageOf());
  const editing = customer.addresses.nodes.find((address) => address.id === edit);
  const refused = ADDRESS_FIELDS.find((field) => field === error);
  return (
    <>
      <h1>{words.addresses}</h1>
      <p>
        <Link href="/account">{words.backToAccount}</Link>
      </p>
      {error !== undefined && (
        <p className="problem" role="alert">
          {words.addressProblem} {refused ? labelOf(refused, words) : ''}
        </p>
      )}
      {customer.addresses.nodes.length === 0 && <p>{words.noAddresses}</p>}
      <ul className="addresses">
        {customer.addresses.nodes.map((address) => (
          <li key={address.id}>
            <address dir="auto">
              {address.formatted.map((line, at) => (
                <span key={at}>{line}</span>
              ))}
            </address>
            {address.id === customer.defaultAddress?.id ? (
              <strong>{words.defaultAddress}</strong>
            ) : (
              <form action={makeDefault}>
                <input type="hidden" name="id" value={address.id} />
                <button type="submit">{words.makeDefault}</button>
              </form>
            )}
            <Link href={`/account/addresses?${new URLSearchParams({ edit: address.id })}`}>
              {words.edit}
            </Link>
            <form action={deleteAddress}>
              <input type="hidden" name="id" value={address.id} />
              <button type="submit" className="quiet">
                {words.remove}
              </button>
            </form>
          </li>
        ))}
      </ul>
      <h2>{editing ? words.editAddress : words.addAddress}</h2>
      <AddressForm key={editing?.id ?? 'new'} address={editing} words={words} />
    </>
  );
}
