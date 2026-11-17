import {
  HttpError,
  MAX_BYTES,
  readBounded,
  validateFolder,
  validateTitle,
  validateCategory,
} from "./common";
import { extractZip, type SiteFile } from "./zip";

export async function parseUpload(request: Request): Promise<{
  files: SiteFile[];
  name?: string;
  note: string;
  folder?: string;
  title?: string;
  hostId?: string;
  hostName?: string;
  opaqueBinding?: string;
  resolves?: string[];
}> {
  const params = new URL(request.url).searchParams;
  if (params.has("scope")) {
    throw new HttpError(400, "scope parameter has been removed");
  }
  let name = params.get("name") ?? undefined;
  let note = params.get("note") ?? "";
  let folderRaw = params.get("folder") ?? undefined;
  let projectRaw = params.get("project") ?? undefined;
  let taskRaw = params.get("task") ?? undefined;
  let titleRaw = params.get("title") ?? undefined;
  let hostIdRaw = params.get("host_id") ?? undefined;
  let hostNameRaw = params.get("host_name") ?? undefined;
  let bindingRaw = params.get("binding") ?? undefined;
  let resolvesRaw = params.has("resolves") ? params.getAll("resolves").join(",") : undefined;

  const type = request.headers.get("Content-Type") ?? "";
  const multipart = /^multipart\/form-data\b/i.test(type);
  const limit = MAX_BYTES + (multipart ? 64 * 1024 : 0);
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > limit) throw new HttpError(413, "Upload exceeds 20 MiB");
  let body = await readBounded(request.body, limit);
  let filename = "";
  let fileType = type.split(";")[0].toLowerCase().trim();
  if (multipart) {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "Content-Type": type } }).formData();
    } catch {
      throw new HttpError(400, "Invalid multipart form");
    }
    const fields = [...form.entries()];
    const file = form.get("file");
    const allowed = [
      "file",
      "name",
      "note",
      "folder",
      "project",
      "task",
      "title",
      "host_id",
      "host_name",
      "binding",
      "resolves",
    ];
    if (
      !(file instanceof File) ||
      fields.some(
        ([key, value]) =>
          !allowed.includes(key) ||
          form.getAll(key).length !== 1 ||
          (key !== "file" && typeof value !== "string"),
      )
    ) {
      throw new HttpError(400, "Send one file field and optional text metadata fields");
    }
    name = form.has("name") ? String(form.get("name")) : name;
    note = form.has("note") ? String(form.get("note")) : note;
    folderRaw = form.has("folder") ? String(form.get("folder")) : folderRaw;
    projectRaw = form.has("project") ? String(form.get("project")) : projectRaw;
    taskRaw = form.has("task") ? String(form.get("task")) : taskRaw;
    titleRaw = form.has("title") ? String(form.get("title")) : titleRaw;
    hostIdRaw = form.has("host_id") ? String(form.get("host_id")) : hostIdRaw;
    hostNameRaw = form.has("host_name") ? String(form.get("host_name")) : hostNameRaw;
    bindingRaw = form.has("binding") ? String(form.get("binding")) : bindingRaw;
    resolvesRaw = form.has("resolves") ? String(form.get("resolves")) : resolvesRaw;

    filename = file.name;
    fileType = file.type.toLowerCase();
    if (file.size > MAX_BYTES) throw new HttpError(413, "Upload exceeds 20 MiB");
    body = new Uint8Array(await file.arrayBuffer());
  }

  if (name !== undefined && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)) {
    throw new HttpError(
      400,
      "name must be kebab-case, start with a letter, and be at most 64 characters",
    );
  }
  if (note.length > 500 || /[\x00-\x1f\x7f]/.test(note)) {
    throw new HttpError(400, "note must be a single line of at most 500 characters");
  }

  if ((projectRaw !== undefined || taskRaw !== undefined) && (!projectRaw || !taskRaw)) {
    throw new HttpError(400, "project and task must be supplied together");
  }
  let folder: string | undefined;
  if (folderRaw) {
    folder = validateFolder(folderRaw);
  } else if (projectRaw && taskRaw) {
    folder = validateFolder(`${validateCategory(projectRaw)}/${validateCategory(taskRaw)}`);
  }

  const title = validateTitle(titleRaw);

  const hostId = hostIdRaw?.trim() || undefined;
  const hostName = hostNameRaw?.trim() || undefined;
  const opaqueBinding = bindingRaw?.trim() || undefined;
  if (opaqueBinding !== undefined && opaqueBinding.length > 4096) {
    throw new HttpError(400, "binding exceeds 4 KiB limit");
  }

  let resolves: string[] | undefined;
  if (resolvesRaw !== undefined) {
    const parsedResolves = resolvesRaw
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (parsedResolves.length > 0) {
      resolves = parsedResolves;
    }
  }

  if (!body.byteLength) throw new HttpError(400, "Empty upload");
  const isZip =
    /\.zip$/i.test(filename) ||
    ["application/zip", "application/x-zip-compressed"].includes(fileType) ||
    (body[0] === 0x50 && body[1] === 0x4b);
  let files: SiteFile[];
  if (isZip) files = await extractZip(body);
  else if (fileType === "text/html" || /\.html?$/i.test(filename)) {
    files = [{ path: "index.html", data: body }];
  } else {
    throw new HttpError(
      415,
      "Send an HTML file or ZIP (multipart file, text/html, or application/zip)",
    );
  }
  if (files.some(file => /^v[1-9]\d*(?:\/|$)/.test(file.path))) {
    throw new HttpError(400, "Named previews reserve v<N> at the site root");
  }
  return {
    files,
    name,
    note,
    folder,
    title,
    ...(hostId !== undefined ? { hostId } : {}),
    ...(hostName !== undefined ? { hostName } : {}),
    ...(opaqueBinding !== undefined ? { opaqueBinding } : {}),
    ...(resolves !== undefined ? { resolves } : {}),
  };
}
