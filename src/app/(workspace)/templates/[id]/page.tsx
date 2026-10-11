import { notFound } from "next/navigation";
import { TemplateView } from "@/components/templates/TemplateView";
import { ApiError } from "@/lib/api/errors";
import { requirePageScope } from "@/lib/auth/scope-page";
import {
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
  drawingBasemaps,
} from "@/lib/basemap-offer";
import { readTemplate } from "@/lib/templates/catalogue";
import { openedTemplate } from "@/lib/templates/view";

/**
 * A template's own address, for every signed-in account: the version the
 * read of one names, read only. An installed version opens at once, its
 * map through the map's own roads and a workflow example's canvas from
 * the documents read here, since no recipe road answers a template's; a
 * version not on this server yet is downloaded by the page first. Nothing
 * here reaches outside or writes.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageScope();
  const { id } = await params;
  let template;
  try {
    template = await readTemplate(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const opened = template.present ? openedTemplate(template.id, template.version) : null;
  return (
    <TemplateView
      template={template}
      opened={opened}
      basemapUrl={basemapUrl()}
      basemapOverrideUrl={basemapOverrideUrl()}
      basemapOverrideAttribution={basemapOverrideAttribution()}
      basemaps={drawingBasemaps()}
    />
  );
}
