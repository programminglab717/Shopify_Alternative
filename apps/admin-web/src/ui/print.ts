/**
 * A tab for a document to print, opened while the merchant's tap is still being handled, so
 * that browsers' pop-up blockers let it through, and filled in once the document is fetched.
 * Null where the browser refused even so.
 */
export function openPrintTab(): {
  show: (html: string) => void;
  close: () => void;
} | null {
  const tab = window.open('', '_blank');
  if (!tab) return null;
  return {
    show(html) {
      tab.document.open();
      tab.document.write(html);
      tab.document.close();
      // Hatti's printed pages load their fonts; printing before they are in prints a fallback.
      void tab.document.fonts.ready.then(() => {
        tab.focus();
        tab.print();
      });
    },
    close() {
      tab.close();
    },
  };
}
