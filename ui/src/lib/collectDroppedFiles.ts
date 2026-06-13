/** Collect files from drag-drop, including nested folder contents. */

function fileWithRelativePath(file: File, relativePath: string): File {
  if (file.webkitRelativePath) return file;
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      value: relativePath,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Some browsers block redefining; caller may pass path separately.
  }
  return file;
}

function readFileEntry(entry: FileSystemFileEntry, relativePath: string): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(fileWithRelativePath(file, relativePath)),
      (error) => reject(error),
    );
  });
}

function readDirectoryEntry(entry: FileSystemDirectoryEntry, prefix: string): Promise<File[]> {
  const reader = entry.createReader();
  const collected: File[] = [];

  const readBatch = (): Promise<void> =>
    new Promise((resolve, reject) => {
      reader.readEntries(
        async (entries) => {
          if (entries.length === 0) {
            resolve();
            return;
          }
          for (const child of entries) {
            const childPath = prefix ? `${prefix}/${child.name}` : child.name;
            if (child.isFile) {
              collected.push(await readFileEntry(child as FileSystemFileEntry, childPath));
            } else if (child.isDirectory) {
              collected.push(...(await readDirectoryEntry(child as FileSystemDirectoryEntry, childPath)));
            }
          }
          await readBatch();
          resolve();
        },
        (error) => reject(error),
      );
    });

  return readBatch().then(() => collected);
}

export async function collectFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = dataTransfer.items;
  if (!items || items.length === 0) {
    return Array.from(dataTransfer.files);
  }

  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (!entry) {
      const file = item.getAsFile();
      if (file) files.push(file);
      continue;
    }
    if (entry.isFile) {
      files.push(await readFileEntry(entry as FileSystemFileEntry, entry.name));
    } else if (entry.isDirectory) {
      files.push(...(await readDirectoryEntry(entry as FileSystemDirectoryEntry, entry.name)));
    }
  }

  return files.length > 0 ? files : Array.from(dataTransfer.files);
}

export function relativePathForFile(file: File): string {
  return file.webkitRelativePath || file.name;
}
