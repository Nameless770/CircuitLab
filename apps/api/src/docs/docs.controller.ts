import { dirname } from "node:path";
import { openApi } from "@circuitlab/api-contract";
import { Controller, Get, Module, NotFoundException, Param, Res, VERSION_NEUTRAL } from "@nestjs/common";
import type { Response } from "express";
import { IgnoresAccessToken } from "../auth/authentication.guard";
import { DOCS_INIT, DOCS_PAGE, SPEC_PATH, SWAGGER_UI_FILES } from "./swagger-ui";

/** Where swagger-ui-dist keeps its files (the folder of its package.json). */
const SWAGGER_UI_DIR = dirname(require.resolve("swagger-ui-dist/package.json"));

/**
 * The API's documentation, outside the versioned API (like /health): Swagger UI at `/docs`, on the
 * contract the server itself is built from (packages/api-contract/openapi.yaml), so the page can't
 * disagree with the API. `/` leads there. None of it needs a token.
 *
 * The contract lists `http://localhost:3000/v1` as its server, which is right for someone reading
 * the file but wrong for a page served from anywhere else. So the served copy names a relative
 * server, `/v1`: wherever this page is open, "Try it out" calls that same server.
 */
@Controller({ path: "", version: VERSION_NEUTRAL })
@IgnoresAccessToken()
export class DocsController {
  private readonly spec = JSON.stringify({ ...(openApi as object), servers: [{ url: "/v1", description: "This server" }] });

  @Get()
  root(@Res() response: Response): void {
    response.redirect(302, "/docs");
  }

  @Get("docs")
  page(@Res() response: Response): void {
    response.type("html").set("Cache-Control", "no-cache").send(DOCS_PAGE);
  }

  @Get("docs/init.js")
  init(@Res() response: Response): void {
    response.type("js").set("Cache-Control", "no-cache").send(DOCS_INIT);
  }

  @Get("docs/assets/:file")
  async asset(@Param("file") file: string, @Res() response: Response): Promise<void> {
    if (!SWAGGER_UI_FILES.has(file)) throw new NotFoundException();
    await new Promise<void>((resolve, reject) => {
      response.sendFile(file, { root: SWAGGER_UI_DIR, maxAge: "1d" }, (error?: Error) => {
        // A client that goes away mid-download isn't a problem worth reporting.
        if (error !== undefined && !response.headersSent) reject(error);
        else resolve();
      });
    });
  }

  @Get(SPEC_PATH.slice(1))
  contract(@Res() response: Response): void {
    // The contract is public, and carries no credentials, so any web page (an online editor, say) may read it.
    response.type("json").set({ "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" }).send(this.spec);
  }
}

@Module({ controllers: [DocsController] })
export class DocsModule {}
