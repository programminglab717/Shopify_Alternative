// The cart's cross-sells (MKT-09, ADR-437, ADR-440): asks for the products the shop pairs with
// each product the cart names, merges them in turn, leaves out those the cart holds and any
// twice, keeps to its limit, and shows itself once there is one. Used by the cart page and the
// cart drawer.
// In a block: the cart page and its drawer may both load it.
{
  class HattiCartUpsells extends HTMLElement {
    async connectedCallback() {
      const urls = (this.dataset.urls || '').split(' ').filter(Boolean);
      const held = new Set((this.dataset.inCart || '').split(' ').filter(Boolean));
      const limit = Number(this.dataset.limit) || 4;
      const pages = await Promise.all(
        urls.map(async (url) => {
          try {
            const response = await fetch(url);
            return response.ok ? await response.text() : '';
          } catch {
            return '';
          }
        }),
      );
      const list = this.querySelector('ul');
      const shown = new Set(held);
      for (const html of pages) {
        const page = new DOMParser().parseFromString(html, 'text/html');
        for (const item of page.querySelectorAll('li[data-product-id]')) {
          const id = item.getAttribute('data-product-id');
          if (!id || shown.has(id) || list.childElementCount >= limit) continue;
          shown.add(id);
          list.append(document.importNode(item, true));
        }
      }
      if (list.childElementCount > 0) this.hidden = false;
    }
  }
  if (!customElements.get('hatti-cart-upsells')) {
    customElements.define('hatti-cart-upsells', HattiCartUpsells);
  }
}
