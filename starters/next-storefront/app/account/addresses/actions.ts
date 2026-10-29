'use server';

import { redirect } from 'next/navigation';
import { customerToken } from '@/app/account/actions';
import { ADDRESS_FIELDS } from '@/lib/addresses';
import { storefront } from '@/lib/hatti';
import {
  CUSTOMER_ADDRESS_CREATE_MUTATION,
  CUSTOMER_ADDRESS_DELETE_MUTATION,
  CUSTOMER_ADDRESS_UPDATE_MUTATION,
  CUSTOMER_DEFAULT_ADDRESS_UPDATE_MUTATION,
} from '@/lib/queries';
import type { AddressUserError } from '@/lib/types';

// The shopper's address book (ADR-947), changed through the Storefront API (ADR-946) with the
// customer access token their cookie keeps. What the API refuses comes back to the page by the
// field it names, which the page says in the shopper's language.

async function signedIn(): Promise<string> {
  const token = await customerToken();
  if (!token) redirect('/account/login');
  return token;
}

/** Where the page goes once the API answered: back to the book, saying why not where it refused. */
function after(errors: AddressUserError[], editing: string | null): never {
  const refused = errors[0];
  if (!refused) redirect('/account/addresses');
  if (refused.code === 'UNIDENTIFIED_CUSTOMER') redirect('/account/login');
  const field = refused.field?.at(-1) ?? '';
  const params = new URLSearchParams({ error: field });
  if (editing) params.set('edit', editing);
  redirect(`/account/addresses?${params}`);
}

/** Adds the form's address, or changes the one it names. */
export async function saveAddress(form: FormData): Promise<void> {
  const token = await signedIn();
  const id = String(form.get('id') ?? '') || null;
  const address = Object.fromEntries(
    ADDRESS_FIELDS.map((field) => [field, String(form.get(field) ?? '').trim() || null]),
  );
  if (id) {
    const { customerAddressUpdate } = await storefront<{
      customerAddressUpdate: { customerUserErrors: AddressUserError[] };
    }>(
      CUSTOMER_ADDRESS_UPDATE_MUTATION,
      { customerAccessToken: token, id, address },
      { cache: 'none' },
    );
    after(customerAddressUpdate.customerUserErrors, id);
  }
  const { customerAddressCreate } = await storefront<{
    customerAddressCreate: { customerUserErrors: AddressUserError[] };
  }>(
    CUSTOMER_ADDRESS_CREATE_MUTATION,
    { customerAccessToken: token, address: { ...address, country: 'Pakistan' } },
    { cache: 'none' },
  );
  after(customerAddressCreate.customerUserErrors, null);
}

/** Makes the form's address the one delivered to first. */
export async function makeDefault(form: FormData): Promise<void> {
  const token = await signedIn();
  const { customerDefaultAddressUpdate } = await storefront<{
    customerDefaultAddressUpdate: { customerUserErrors: AddressUserError[] };
  }>(
    CUSTOMER_DEFAULT_ADDRESS_UPDATE_MUTATION,
    { customerAccessToken: token, addressId: String(form.get('id') ?? '') },
    { cache: 'none' },
  );
  after(customerDefaultAddressUpdate.customerUserErrors, null);
}

/** Takes the form's address out of the book. */
export async function deleteAddress(form: FormData): Promise<void> {
  const token = await signedIn();
  const { customerAddressDelete } = await storefront<{
    customerAddressDelete: { customerUserErrors: AddressUserError[] };
  }>(
    CUSTOMER_ADDRESS_DELETE_MUTATION,
    { customerAccessToken: token, id: String(form.get('id') ?? '') },
    { cache: 'none' },
  );
  after(customerAddressDelete.customerUserErrors, null);
}
