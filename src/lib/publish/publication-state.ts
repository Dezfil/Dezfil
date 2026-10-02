import type { AccountScope } from "@/lib/auth/scope";
import { ownsMap, requireMap, requireMapFor } from "@/lib/map-access";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { getMap, getMapByToken, getPublishedTheme, getViewerControls,
  normalizeViewerControls, setPublishedTheme, setViewerControls,
  updateMapFields, type PublishedTheme, type ViewerControls } from "@/lib/metadata/maps";
import { generateToken } from "./token";
import { invalidatePublishedToken } from "./publication-resolution";

export interface PublishState {
  token: string;
  publishedAt: string;
}

/** The active publication's authored settings. The author
 * surface reads this: a map record deliberately carries no publication
 * state, so without it the publish surface could not show the default it
 * is about to change. The token is the map owner's alone: anyone else who
 * reaches the map reads the settings without it. */
export interface PublicationState extends Omit<PublishState, "token"> {
  token?: string;
  theme: PublishedTheme;
  viewerControls: ViewerControls;
}

/** What a publish call may state. Each field is independently optional,
 * and that independence is load-bearing: the builder's workspace-theme
 * sync states a theme and nothing else, and must never re-enable
 * controls the author unchecked. */
export interface PublishSettings {
  theme?: PublishedTheme;
  viewerControls?: Partial<ViewerControls>;
}

/** Read an active publication's settings, or null when the map is not
 * published. Normalizing here — not at each surface — is what keeps a
 * earlier publication, an unstated setting and an omitted member all
 * reading as every control on. */
export function getPublicationState(scope: AccountScope, id: string): PublicationState | null {
  const map = requireMap(scope, id);
  if (!map.publishToken || !map.publishedAt) return null;
  return {
    ...(ownsMap(scope, id) ? { token: map.publishToken } : {}),
    publishedAt: map.publishedAt,
    theme: getPublishedTheme(id) ?? "dark",
    viewerControls: normalizeViewerControls(getViewerControls(id)),
  };
}

/** Minting, changing and revoking a publication are the map owner's acts. */
function requirePublishedMapOwner(scope: AccountScope, id: string) {
  return requireMapFor(scope, id, "publish");
}

/** Publish a map, or return the existing link unchanged if already published
 * (spec: one active link per map; republish returns the same URL). The
 * authored theme is captured here: stated wins; omitted reads dark on a
 * first publication and changes nothing on an active one. A stated mode
 * on an active publication updates the stored default in place — the link
 * is the contract and the token never moves for a theme. The viewer
 * controls follow the same in-place rule, and the two settings are tested
 * for presence independently: a call stating only a theme leaves the
 * checklist exactly as the author left it. */
export function publishMap(
  scope: AccountScope,
  id: string,
  settings: PublishSettings = {},
): PublishState {
  return metadataDb().transaction(() => {
    const map = requirePublishedMapOwner(scope, id);
    const { theme, viewerControls } = settings;
    if (map.publishToken && map.publishedAt) {
      if (theme) setPublishedTheme(id, theme);
      if (viewerControls) {
        setViewerControls(id, normalizeViewerControls(viewerControls));
      }
      return { token: map.publishToken, publishedAt: map.publishedAt };
    }
    const token = generateToken();
    const publishedAt = new Date().toISOString();
    updateMapFields(id, { publishToken: token, publishedAt });
    setPublishedTheme(id, theme ?? "dark");
    // An unstated set is stored as null, which reads as every control on;
    // storing the normalized default instead would be indistinguishable
    // but says something the author never stated.
    setViewerControls(
      id,
      viewerControls ? normalizeViewerControls(viewerControls) : null,
    );
    return { token, publishedAt };
  })();
}

/** Unpublish: the link stops resolving immediately; a later republish mints a
 * fresh, unrelated token (spec: rotation is the revocation story). */
export function unpublishMap(scope: AccountScope, id: string): void {
  const token = metadataDb().transaction(() => {
    const map = requirePublishedMapOwner(scope, id);
    updateMapFields(id, { publishToken: null, publishedAt: null });
    // The authored theme is publication state: it leaves with the token,
    // so the next publication captures fresh. The viewer controls are
    // publication state too and leave with it.
    setPublishedTheme(id, null);
    setViewerControls(id, null);
    return map.publishToken;
  })();
  if (token) invalidatePublishedToken(token);
}

/** Guard used by mutation endpoints: a published token never authorizes a
 * write. Kept explicit so the read-only guarantee is testable. */
export function assertNotUsingPublishTokenAsAuth(id: string): void {
  // Map ids and publish tokens are distinct namespaces; a token is never a
  // valid map id for mutation. Present for clarity and future-proofing.
  if (getMapByToken(id) && !getMap(id)) {
    throw new ApiError("not_found", "No such map.", 404);
  }
}
