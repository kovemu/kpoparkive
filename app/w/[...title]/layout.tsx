import type { ReactNode } from "react";

export default function WikiTitleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{`
        /* The pinned The Tree frontend uses an old icon-font glyph for heading
           disclosure markers. Without that font it renders as a boxed X.
           Draw the disclosure chevron with CSS so every wiki page matches the
           current NamuWiki behavior without depending on legacy icon fonts. */
        .kpoparkiveRawWikiPage .wiki-heading::before,
        .thetreeWikiBaseline .wiki-heading::before,
        .namumarkPocDocument.wiki-content .wiki-heading::before {
          content: "" !important;
          display: inline-block !important;
          box-sizing: border-box !important;
          width: .48em !important;
          height: .48em !important;
          margin: 0 .62em .16em .08em !important;
          padding: 0 !important;
          border: 0 !important;
          border-right: 2px solid #62676d !important;
          border-bottom: 2px solid #62676d !important;
          border-radius: 0 !important;
          background: none !important;
          color: transparent !important;
          font-family: inherit !important;
          font-size: inherit !important;
          line-height: 1 !important;
          vertical-align: middle !important;
          transform: rotate(45deg) !important;
          transform-origin: 58% 58% !important;
          transition: transform .12s ease !important;
        }

        .kpoparkiveRawWikiPage .wiki-heading.wiki-heading-folded::before,
        .thetreeWikiBaseline .wiki-heading.wiki-heading-folded::before,
        .namumarkPocDocument.wiki-content .wiki-heading.wiki-heading-folded::before {
          transform: rotate(-45deg) !important;
        }
      `}</style>
      {children}
    </>
  );
}
