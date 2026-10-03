// What the documentation page is made of: a small HTML page, and the script that starts Swagger UI
// on the API's own contract. Swagger UI itself (swagger-ui-dist) is served from node_modules, so
// the page needs nothing from the internet.

/** Where the spec is served; `docs.controller.ts` answers it. */
export const SPEC_PATH = "/openapi.json";

/** The only files of swagger-ui-dist the page uses. Nothing else in that folder is ever served. */
export const SWAGGER_UI_FILES: ReadonlySet<string> = new Set(["swagger-ui.css", "swagger-ui-bundle.js", "favicon-32x32.png"]);

/** The page at /docs. Its script is a file of its own (`init.js`), so the page has no inline script. */
export const DOCS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CircuitLab API</title>
    <link rel="icon" type="image/png" href="/docs/assets/favicon-32x32.png">
    <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <noscript>The API documentation needs JavaScript. The contract itself is at <a href="${SPEC_PATH}">${SPEC_PATH}</a>.</noscript>
    <script src="/docs/assets/swagger-ui-bundle.js"></script>
    <script src="/docs/init.js"></script>
  </body>
</html>
`;

/** Starts Swagger UI on the contract. "Try it out" calls this same server, so no CORS is involved. */
export const DOCS_INIT = `window.ui = SwaggerUIBundle({
  url: "${SPEC_PATH}",
  dom_id: "#swagger-ui",
  deepLinking: true,
  displayRequestDuration: true,
  defaultModelsExpandDepth: 0,
});
`;
