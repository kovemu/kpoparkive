import type { ReactNode } from "react";
import SiteHeader from "./SiteHeader";

function encodeWikiTitle(title: string) {
  return title.split("/").map((part) => encodeURIComponent(part)).join("/");
}

const PUBLIC_EDITING_ENABLED =
  process.env.NEXT_PUBLIC_PUBLIC_EDITING_ENABLED === "true";

export default function WikiShell({
  title,
  sourceTitle,
  children,
}: {
  title: string;
  sourceTitle?: string;
  children: ReactNode;
}) {
  const encodedTitle = encodeWikiTitle(sourceTitle || title);

  return (
    <div className="wikiSiteShell">
      <SiteHeader />
      <main className="wikiDocumentColumn">
        <header className="wikiDocumentHeader">
          <h1>{title}</h1>
          {PUBLIC_EDITING_ENABLED ? (
            <a className="wikiEditLink" href={"/edit/" + encodedTitle}>
              Edit
            </a>
          ) : null}
        </header>
        <div className="wikiArticleFrame">{children}</div>
      </main>
    </div>
  );
}
