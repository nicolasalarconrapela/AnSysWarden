import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import type { TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';

export const ALLOCATION_SCHEMA = 'ansyswarden.tree-allocation.v1';

export interface AllocatedFileRecord {
  record: 'file';
  path: string;
  allocatedBytes: number | null;
  error?: string;
}

export interface AllocationSummary {
  record: 'summary';
  schema: typeof ALLOCATION_SCHEMA;
  sourceScanId: string;
  sourceIndex: string;
  measuredAt: string;
  totalFiles: number;
  measuredFiles: number;
  failedFiles: number;
  allocatedBytesMeasured: number;
  complete: boolean;
  method: 'GetCompressedFileSizeW';
  notes: string[];
}

export function defaultAllocationPath(metadata: TreeScanMetadata): string {
  return join(dirname(dirname(metadata.indexPath)), 'allocations', metadata.id + '.jsonl');
}

// Se utiliza un proceso persistente: compilar el puente .NET por archivo
// sería demasiado costoso en índices de 100.000 o más ficheros.
const psScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$definition = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AnSysWardenAllocatedSize {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetCompressedFileSizeW")]
  private static extern uint GetCompressedFileSize(string path, out uint high);

  [DllImport("kernel32.dll", EntryPoint="SetLastError")]
  private static extern void SetLastError(uint error);

  public static ulong Read(string path) {
    uint high;
    SetLastError(0);
    uint low = GetCompressedFileSize(path, out high);
    int error = Marshal.GetLastWin32Error();
    if (low == UInt32.MaxValue && error != 0) throw new Win32Exception(error);
    return ((ulong)high << 32) | low;
  }
}
'@
Add-Type -TypeDefinition $definition -Language CSharp
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    $allocated = [AnSysWardenAllocatedSize]::Read([string]$request.path)
    $response = @{ path = [string]$request.path; allocatedBytes = [double]$allocated }
  } catch {
    $response = @{ path = [string]$request.path; allocatedBytes = $null; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 3))
}
`;

export async function measureAllocatedSpace(
  metadata: TreeScanMetadata,
  options: {
    outputPath?: string;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ outputPath: string; summary: AllocationSummary }> {
  if (platform() !== 'win32') {
    throw new Error('La medición GetCompressedFileSizeW requiere Windows. No se ha modificado el índice.');
  }
  if (!metadata.entries || metadata.files === 0) {
    throw new Error('El índice no contiene archivos normales para medir.');
  }

  const outputPath = resolve(options.outputPath ?? defaultAllocationPath(metadata));
  await mkdir(dirname(outputPath), { recursive: true });
  const tmpPath = outputPath + '.tmp-' + process.pid;
  const output = createWriteStream(tmpPath, { flags: 'w', encoding: 'utf8' });

  let measuredFiles = 0;
  let failedFiles = 0;
  let allocatedBytesMeasured = 0;
  let received = 0;
  let stderr = '';

  const write = async (line: string): Promise<void> => {
    if (!output.write(line + '\n')) await once(output, 'drain');
  };

  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(psScript, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 16000) stderr += chunk.slice(0, 16000 - stderr.length);
  });

  const producer = async (): Promise<number> => {
    let sent = 0;
    const lines = createInterface({ input: createReadStream(metadata.indexPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as TreeIndexRecord;
      // Las uniones y enlaces no se miden: la API sigue el enlace y puede
      // contabilizar el archivo de destino por segunda vez.
      if (record.record !== 'entry' || record.type !== 'file') continue;
      if (!child.stdin.write(JSON.stringify({ path: record.path }) + '\n', 'utf8')) {
        await once(child.stdin, 'drain');
      }
      sent++;
    }
    child.stdin.end();
    return sent;
  };

  const consumer = async (): Promise<void> => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line) as { path: string; allocatedBytes: number | null; error?: string };
      const allocated = response.allocatedBytes;
      const valid = typeof allocated === 'number' && Number.isSafeInteger(allocated) && allocated >= 0;
      if (valid) {
        allocatedBytesMeasured += allocated;
        measuredFiles++;
      } else {
        failedFiles++;
      }
      await write(JSON.stringify({
        record: 'file',
        path: response.path,
        allocatedBytes: valid ? allocated : null,
        ...(valid ? {} : { error: response.error ?? 'Medición no disponible' }),
      } satisfies AllocatedFileRecord));
      received++;
      if (received % 5000 === 0) options.onProgress?.(received, metadata.files);
    }
  };

  try {
    await write(JSON.stringify({
      record: 'header', schema: ALLOCATION_SCHEMA, sourceScanId: metadata.id,
      sourceIndex: metadata.indexPath, method: 'GetCompressedFileSizeW',
    }));
    const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
    const [sent, , [exitCode]] = await Promise.all([producer(), consumer(), closed]);
    if (exitCode !== 0 || sent !== received || sent !== metadata.files) {
      throw new Error(
        'Medición incompleta: solicitudes=' + sent + ', respuestas=' + received +
        ', esperadas=' + metadata.files + ', exit=' + exitCode +
        (stderr ? '\nPowerShell: ' + stderr.slice(0, 1500) : '')
      );
    }

    const summary: AllocationSummary = {
      record: 'summary',
      schema: ALLOCATION_SCHEMA,
      sourceScanId: metadata.id,
      sourceIndex: metadata.indexPath,
      measuredAt: new Date().toISOString(),
      totalFiles: sent,
      measuredFiles,
      failedFiles,
      allocatedBytesMeasured,
      complete: failedFiles === 0,
      method: 'GetCompressedFileSizeW',
      notes: [
        'Se miden solo archivos normales del índice original, sin seguir symlinks ni junctions.',
        'Los archivos pudieron cambiar desde el escaneo: el tamaño físico es una segunda captura.',
        'El resultado no incluye metadatos NTFS, directorios, hardlinks duplicados ni todos los costes del volumen.',
        'Si existe algún fallo, el agregado de bytes es parcial, nunca un total completo.',
      ],
    };
    await write(JSON.stringify(summary));
    output.end();
    await finished(output);
    await rename(tmpPath, outputPath);
    options.onProgress?.(received, metadata.files);
    return { outputPath, summary };
  } catch (error) {
    child.kill();
    output.destroy();
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
