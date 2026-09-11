import type { ReactNode } from "react";
import SiteHeader from "./SiteHeader";

function encodeWikiTitle(title: string) {
  return title.split("/").map((part) => encodeURIComponent(part)).join("/");
}

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
          <a className="wikiEditLink" href={"/edit/" + encodedTitle}>
            Edit
          </a>
        </header>
        <div className="wikiArticleFrame">{children}</div>
      </main>
    </div>
  );
}
