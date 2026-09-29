import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { mapWithLayers } from "@/lib/map-service";
import { baseFields } from "@/lib/layer-service";
import {
  publishedFieldsStatement,
  type PublishedFieldsStatement,
} from "@/lib/publish/published-fields";

type Params = { params: Promise<{ id: string }> };

interface LayerStatement extends Partial<PublishedFieldsStatement> {
  layerId: string;
  name: string;
  /** A hidden layer shares nothing — it is absent from the published
   * surface entirely, and the statement says so instead of deriving a
   * set no wire will carry. */
  hidden?: boolean;
  /** Present when the layer's SQL cannot be described right now — the
   * statement degrades per layer, the rest of the map keeps answering. */
  error?: string;
}

/**
 * What each layer will share when this map is published: the effective
 * published field set, its mode, and what an explicit list could add. The
 * publish surface renders exactly this — the statement is the API's, so a
 * headless caller reads the same truth the UI shows.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const map = mapWithLayers(scope, id);
    const layers: LayerStatement[] = await Promise.all(
      map.layers.map(async (layer): Promise<LayerStatement> => {
        if (!layer.visible) {
          return {
            layerId: layer.id,
            name: layer.name,
            hidden: true,
            fields: [],
          };
        }
        try {
          const columns = (await baseFields(layer, request.signal)).map(
            (f) => f.name,
          );
          return {
            layerId: layer.id,
            name: layer.name,
            ...publishedFieldsStatement(layer, map, columns),
          };
        } catch (error) {
          return {
            layerId: layer.id,
            name: layer.name,
            error:
              error instanceof Error
                ? error.message
                : "The layer's fields could not be resolved.",
          };
        }
      }),
    );
    return NextResponse.json({ layers });
  } catch (error) {
    return errorResponse(error);
  }
}
