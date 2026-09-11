import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const treeRoot = path.join(root, "node_modules", "thetree");

if (!fs.existsSync(treeRoot)) {
  console.log("The Tree dependency is not installed; skipping runtime patch.");
  process.exit(0);
}

function patch(relativePath, before, after, label) {
  const target = path.join(treeRoot, relativePath);
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(after)) {
    console.log(`The Tree patch already applied: ${label}`);
    return;
  }
  if (!source.includes(before)) {
    throw new Error(`The Tree patch target changed: ${label} (${relativePath})`);
  }
  fs.writeFileSync(target, source.replace(before, after), "utf8");
  console.log(`Applied The Tree patch: ${label}`);
}

patch(
  "utils/namumark/utils/index.js",
  `if(![
                            'table',
                            'tbody',
                            'tr',
                            'td'
                        ].includes(node.name))`,
  `if(![
                            'a',
                            'div',
                            'span',
                            'p',
                            'strong',
                            'em',
                            'img',
                            'details',
                            'summary',
                            'ul',
                            'ol',
                            'li',
                            'table',
                            'thead',
                            'tbody',
                            'tfoot',
                            'tr',
                            'th',
                            'td'
                        ].includes(node.name))`,
  "preserve safe type-qualified template CSS selectors",
);

patch(
  "utils/namumark/syntax/table.js",
  "const tagStr = paramStr.slice(1, closeIndex);",
  `const tagStr = paramStr.slice(1, closeIndex)
                    .replace(/\\u00a0/g, ' ')
                    .replace(/=\\s+/g, '=')
                    .replace(/,\\s+/g, ',')
                    .trim();`,
  "treat NBSP as whitespace inside table parameter tokens",
);
