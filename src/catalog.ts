import { HttpError } from "./common";
import type { Database } from "./database";

export interface User {
  id: string;
  github_id: string;
  login: string;
  created_at: string;
}

export interface Document {
  id: string;
  public_id: string;
  scope: string;
  name: string;
  title: string;
  folder: string;
  created_at: string;
  deleting: number;
  share_token?: string | null;
  shared_at?: string | null;
}

export interface Version {
  document_id: string;
  version: number;
  storage_id: string;
  created_at: string;
  note: string;
  files: string;
  total_bytes: number;
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function compareArchives(
  a: { title: string; updatedAt: string },
  b: { title: string; updatedAt: string },
): number {
  const titleCmp = collator.compare(a.title, b.title);
  if (titleCmp !== 0) return titleCmp;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export class Catalog {
  constructor(
    public db: Database,
    private base = "",
  ) {
    this.base = base.replace(/\/$/, "");
  }

  async document(selector: string): Promise<Document | undefined> {
    return (
      await this.db.all<Document>("SELECT * FROM documents WHERE id=? OR public_id=?", [
        selector,
        selector,
      ])
    )[0];
  }

  async named(scope: string, name: string): Promise<Document | undefined> {
    return (
      await this.db.all<Document>("SELECT * FROM documents WHERE scope=? AND name=?", [scope, name])
    )[0];
  }

  async byShareToken(token: string): Promise<Document | undefined> {
    return (
      await this.db.all<Document>(
        "SELECT * FROM documents WHERE share_token = ? AND deleting = 0",
        [token],
      )
    )[0];
  }

  async versions(id: string): Promise<Version[]> {
    return this.db.all<Version>("SELECT * FROM versions WHERE document_id=? ORDER BY version", [id]);
  }

  async latestVersion(docId: string): Promise<Version | undefined> {
    return (
      await this.db.all<Version>(
        "SELECT * FROM versions WHERE document_id = ? ORDER BY version DESC LIMIT 1",
        [docId],
      )
    )[0];
  }

  visible(doc: Document | undefined, user: User): Document {
    if (!doc || doc.deleting || doc.scope !== user.id) {
      throw new HttpError(404, "Document not found");
    }
    return doc;
  }

  archive(doc: Document, versions: Version[]) {
    return {
      id: doc.id,
      publicId: doc.public_id,
      name: doc.name,
      title: doc.title,
      folder: doc.folder,
      shared: Boolean(doc.share_token),
      shareUrl: doc.share_token ? `${this.base}/s/${doc.share_token}/` : null,
      sharedAt: doc.shared_at || null,
      createdAt: doc.created_at,
      updatedAt: versions.at(-1)?.created_at || doc.created_at,
      versions: versions.map(v => ({
        version: v.version,
        createdAt: v.created_at,
        note: v.note,
        fileCount: JSON.parse(v.files).length,
        totalBytes: v.total_bytes,
      })),
    };
  }

  deriveProjects(docs: Document[]) {
    const map = new Map<string, { name: string; createdAt: string; tasks: string[] }>();
    for (const doc of docs) {
      if (!doc.folder || doc.folder === "uncategorized") continue;
      const [project, task = "默认任务"] = doc.folder.split("/");
      let entry = map.get(project);
      if (!entry) {
        entry = { name: project, createdAt: doc.created_at, tasks: [] };
        map.set(project, entry);
      } else if (doc.created_at < entry.createdAt) {
        entry.createdAt = doc.created_at;
      }
      if (!entry.tasks.includes(task)) {
        entry.tasks.push(task);
      }
    }
    return [...map.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || collator.compare(a.name, b.name),
    );
  }

  async list(user: User) {
    const docs = await this.db.all<Document>(
      "SELECT * FROM documents WHERE scope=? AND deleting=0 ORDER BY rowid",
      [user.id],
    );
    const versions = await this.db.all<Version>(
      "SELECT v.* FROM versions v JOIN documents d ON d.id=v.document_id WHERE d.scope=? AND d.deleting=0 ORDER BY v.version",
      [user.id],
    );
    const archives = docs
      .map(d => this.archive(d, versions.filter(v => v.document_id === d.id)))
      .sort(compareArchives);
    return {
      archives,
      projects: this.deriveProjects(docs),
      user: { id: user.id, login: user.login },
    };
  }
}
