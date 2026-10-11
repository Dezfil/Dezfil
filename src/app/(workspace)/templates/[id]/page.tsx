import { notFound } from "next/navigation";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { TemplateView } from "@/components/templates/TemplateView";
import { ApiError } from "@/lib/api/errors";
import { requirePageScope } from "@/lib/auth/scope-page";
import { instanceDefaults } from "@/lib/settings/defaults";
import {
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
  drawingBasemaps,
} from "@/lib/basemap-offer";
import { readTemplateForAddress } from "@/lib/templates/catalogue";
import { openedTemplate } from "@/lib/templates/view";

/**
 * A template's own address, for every signed-in account: the version the
 * read of one names, read only. An installed version opens at once, its
 * map through the map's own roads and a workflow example's canvas from
 * the documents read here, since no recipe road answers a template's; a
 * version not on this server yet is downloaded by the page first. An
 * address shared before this server read the catalogue still opens: an id
 * it does not know has the catalogue read first, as the Templates page's
 * refresh reads it, and is not found only when the catalogue does not list
 * it either. Nothing here writes.
 *
 * A workflow example's canvas opens with the instance's canvas defaults,
 * handed down as a workflow's page hands them; it mounts no assistant
 * pane, so the layer-download control that pane needs is not mounted.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageScope();
  const { id } = await params;
  let template;
  try {
    template = await readTemplateForAddress(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const opened = template.present ? openedTemplate(template.id, template.version) : null;
  return (
    <ScreenDefaultsProvider defaults={instanceDefaults()}>
      <TemplateView
        template={template}
        opened={opened}
        basemapUrl={basemapUrl()}
        basemapOverrideUrl={basemapOverrideUrl()}
        basemapOverrideAttribution={basemapOverrideAttribution()}
        basemaps={drawingBasemaps()}
      />
    </ScreenDefaultsProvider>
  );
}
