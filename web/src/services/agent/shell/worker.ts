import { Bash, InMemoryFs } from "just-bash/browser";
import {
  SHELL_ROOT,
  type ShellChange,
  type ShellRequest,
  type ShellResponse,
  type ShellState,
} from "./protocol.js";

/**
 * 在 Worker 里运行 just-bash：命令只能看到 /work（当前对话目录），没有网络，也没有 Python/JS。
 * 文件内容在命令真正读到时才从 IndexedDB 取（懒加载），所以大目录里只读几个文件的命令很快。
 * Worker 对存储只读；改动作为结果返回，由主线程按“先写内容、再记引用”的顺序保存。
 */

/** 单个文件回传的字符上限。 */
const MAX_FILE_CHARS = 200_000;
/** 随状态保存的环境变量总字符上限，超过就不带环境（只带当前目录）。 */
const MAX_ENV_CHARS = 64 * 1024;
/** 一次命令里文件内容占用的内存上限。 */
const MAX_FS_BYTES = 64 * 1024 * 1024;
const LIMITS = {
  // 与 DeepSeek Harness 的 bash 一致：单条命令 300 秒。死循环靠 maxCommandCount 更快被挡住。
  maxExecutionTimeMs: 300_000,
  maxCommandCount: 20_000,
  maxOutputSize: 1024 * 1024,
};

let database: Promise<IDBDatabase> | undefined;
const openDatabase = () =>
  (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    // 不指定版本：打开主线程已经升级好的当前版本。
    const request = indexedDB.open("chat-demo");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open the local database"));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  }));

const readBlobText = async (hash: string): Promise<string> => {
  const db = await openDatabase();
  const stored = await new Promise<{ blob: Blob } | undefined>((resolve, reject) => {
    const request = db.transaction("workspaceBlobs").objectStore("workspaceBlobs").get(hash);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!stored) {
    throw new Error("file content is missing from local storage");
  }
  return stored.blob.text();
};

/** 记录哪些路径被写过：没读就整体覆盖的懒文件不会触发加载，只能靠这里知道它被改了。 */
class TrackingFs extends InMemoryFs {
  readonly written = new Set<string>();

  private mark(path: string) {
    this.written.add(this.resolvePath("/", path));
  }

  override writeFileSync(...args: Parameters<InMemoryFs["writeFileSync"]>) {
    this.mark(args[0]);
    return super.writeFileSync(...args);
  }

  override async writeFile(...args: Parameters<InMemoryFs["writeFile"]>) {
    this.mark(args[0]);
    return super.writeFile(...args);
  }

  override async appendFile(...args: Parameters<InMemoryFs["appendFile"]>) {
    this.mark(args[0]);
    return super.appendFile(...args);
  }

  override async cp(...args: Parameters<InMemoryFs["cp"]>) {
    this.mark(args[1]);
    return super.cp(...args);
  }

  override async mv(...args: Parameters<InMemoryFs["mv"]>) {
    this.mark(args[1]);
    return super.mv(...args);
  }
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

const run = async ({ id, command, files, state }: ShellRequest): Promise<ShellResponse> => {
  const fs = new TrackingFs(undefined, { maxTotalBytes: MAX_FS_BYTES });
  fs.mkdirSync(SHELL_ROOT, { recursive: true });
  const knownFiles = new Set<string>();
  const knownMarkers = new Set<string>();
  for (const [path, hash] of Object.entries(files)) {
    if (path.endsWith("/")) {
      const dir = path.slice(0, -1);
      knownMarkers.add(dir);
      fs.mkdirSync(`${SHELL_ROOT}/${dir}`, { recursive: true });
    } else {
      knownFiles.add(path);
      fs.writeFileLazy(`${SHELL_ROOT}/${path}`, () => readBlobText(hash));
    }
  }
  // 初始化也走了写入路径，清掉，只记命令自己写过的。
  fs.written.clear();

  // 目录可能在别的分支里不存在；找不到就回到根，不让命令因为一个陈旧的 cwd 失败。
  let cwd = SHELL_ROOT;
  if (state?.cwd) {
    const wanted = `${SHELL_ROOT}/${state.cwd}`;
    if ((await fs.exists(wanted)) && (await fs.stat(wanted)).isDirectory) {
      cwd = wanted;
    }
  }
  const bash = new Bash({ fs, cwd, executionLimits: LIMITS });
  const result = await bash.exec(command, { cwd, ...(state?.env ? { env: state.env } : {}) });

  const notes: string[] = [];
  const changes: ShellChange[] = [];
  const presentFiles = new Set<string>();
  const emptyDirs = new Set<string>();
  const paths = fs.getAllPaths().filter((path) => path.startsWith(`${SHELL_ROOT}/`));
  const hasChild = new Set(paths.map(parentOf));

  for (const path of paths) {
    const name = path.slice(SHELL_ROOT.length + 1);
    // 已知文件只有被写过才可能变了；其余路径可能是新文件、目录或空目录，要看一眼。
    if (knownFiles.has(name) && !fs.written.has(path)) {
      presentFiles.add(name);
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    if (stat.isDirectory) {
      if (!hasChild.has(path)) {
        emptyDirs.add(name);
      }
      continue;
    }
    if (!stat.isFile) {
      continue;
    }
    presentFiles.add(name);
    let content: string;
    try {
      content = await fs.readFile(path);
    } catch (error) {
      notes.push(
        `Could not save ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (content.length > MAX_FILE_CHARS) {
      notes.push(
        `Not saved: ${name} is too long (${content.length} characters; the limit is ${MAX_FILE_CHARS}).`,
      );
      continue;
    }
    changes.push({ path: name, content });
  }
  for (const name of knownFiles) {
    if (!presentFiles.has(name)) {
      changes.push({ path: name, content: null });
    }
  }
  // 清单只有文件：没有文件的目录用以 / 结尾的占位保留，这样 mkdir 之后下一条命令还能 cd 进去。
  for (const dir of emptyDirs) {
    if (!knownMarkers.has(dir)) {
      changes.push({ path: `${dir}/`, content: "" });
    }
  }
  for (const dir of knownMarkers) {
    if (!emptyDirs.has(dir)) {
      changes.push({ path: `${dir}/`, content: null });
    }
  }

  const finalCwd = result.env.PWD;
  const env = Object.fromEntries(Object.entries(result.env));
  const envChars = Object.entries(env).reduce(
    (sum, [key, value]) => sum + key.length + value.length,
    0,
  );
  const next: ShellState = {
    cwd: finalCwd?.startsWith(`${SHELL_ROOT}/`) ? finalCwd.slice(SHELL_ROOT.length + 1) : "",
    env: envChars <= MAX_ENV_CHARS ? env : {},
  };
  return {
    id,
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    changes,
    state: next,
    notes,
  };
};

// 项目的 tsconfig 用的是 DOM 库；Worker 全局只声明用到的两个成员，避免引入 webworker 库造成类型冲突。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ShellRequest>) => void) | null;
  postMessage: (message: ShellResponse) => void;
};

scope.onmessage = (event) => {
  run(event.data)
    .catch(
      (error: unknown): ShellResponse => ({
        id: event.data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((response) => scope.postMessage(response));
};
