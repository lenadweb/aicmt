import { access, readFile, writeFile } from 'node:fs/promises';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  return readFile(filePath, 'utf8');
}

export async function writeFileSafe(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, 'utf8');
}
