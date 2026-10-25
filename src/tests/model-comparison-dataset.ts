import type { ArtifactProfile } from '../profiler/artifact-profiler';

export type CoreExpectation = 'REGENERABLE' | 'PROTECT' | 'UNCERTAIN';

export interface ModelCoreCase {
  id: string;
  label: string;
  path: string;
  profile: ArtifactProfile;
  expected: CoreExpectation;
}

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function makeProfile(
  path: string,
  sizeMb: number,
  fileCount: number,
  directoryCount: number,
  extensions: Array<[string, number, number]>,
  ageDays: number,
): ArtifactProfile {
  return {
    path,
    sizeBytes: Math.round(sizeMb * MB),
    fileCount,
    directoryCount,
    skippedEntries: 0,
    newestMtimeMs: NOW - 24 * 60 * 60 * 1000,
    oldestMtimeMs: NOW - ageDays * 24 * 60 * 60 * 1000,
    extensions: extensions.map(([extension, files, mb]) => ({
      extension,
      files,
      bytes: Math.round(mb * MB),
    })),
  };
}

export const MODEL_COMPARISON_CORE: ModelCoreCase[] = [
  {
    id: 'CORE-001',
    label: 'Gradle cache',
    path: '/home/user/.gradle/caches/modules-2/files-2.1',
    profile: makeProfile('/home/user/.gradle/caches/modules-2/files-2.1', 3200, 6800, 940, [
      ['.jar', 3100, 1800], ['.pom', 2100, 25], ['.module', 900, 12],
    ], 180),
    expected: 'REGENERABLE',
  },
  {
    id: 'CORE-002',
    label: 'npm cache',
    path: '/home/user/.npm/_cacache',
    profile: makeProfile('/home/user/.npm/_cacache', 1150, 18200, 420, [
      ['[sin extensión]', 14500, 980], ['.json', 3300, 95],
    ], 90),
    expected: 'REGENERABLE',
  },
  {
    id: 'CORE-003',
    label: 'IDE index',
    path: '/home/user/.local/share/IDEA/system/index',
    profile: makeProfile('/home/user/.local/share/IDEA/system/index', 1600, 14500, 760, [
      ['.idx', 7200, 820], ['.dat', 6100, 610], ['.bin', 900, 90],
    ], 120),
    expected: 'REGENERABLE',
  },
  {
    id: 'CORE-004',
    label: 'Photo originals',
    path: '/storage/emulated/0/DCIM/Camera',
    profile: makeProfile('/storage/emulated/0/DCIM/Camera', 18400, 2350, 38, [
      ['.jpg', 1800, 11200], ['.heic', 420, 3100], ['.mp4', 130, 3900],
    ], 900),
    expected: 'PROTECT',
  },
  {
    id: 'CORE-005',
    label: 'Documents',
    path: '/home/user/Documents/client-final',
    profile: makeProfile('/home/user/Documents/client-final', 820, 145, 18, [
      ['.docx', 48, 220], ['.pdf', 62, 510], ['.xlsx', 20, 70],
    ], 420),
    expected: 'PROTECT',
  },
  {
    id: 'CORE-006',
    label: 'Database',
    path: '/home/user/data/customer.sqlite',
    profile: makeProfile('/home/user/data/customer.sqlite', 7200, 1, 0, [
      ['.sqlite', 1, 7200],
    ], 620),
    expected: 'PROTECT',
  },
  {
    id: 'CORE-007',
    label: 'Misleading cache photos',
    path: '/home/user/work/cache-photos',
    profile: makeProfile('/home/user/work/cache-photos', 14600, 2400, 44, [
      ['.jpg', 1700, 8800], ['.raw', 520, 5200], ['.xmp', 170, 20],
    ], 1300),
    expected: 'PROTECT',
  },
  {
    id: 'CORE-008',
    label: 'Unknown database',
    path: '/home/user/.app/state/data.db',
    profile: makeProfile('/home/user/.app/state/data.db', 7600, 1, 0, [
      ['.db', 1, 7600],
    ], 300),
    expected: 'UNCERTAIN',
  },
  {
    id: 'CORE-009',
    label: 'Opaque binary store',
    path: '/home/user/.app/store/objects.bin',
    profile: makeProfile('/home/user/.app/store/objects.bin', 9400, 1, 0, [
      ['.bin', 1, 9400],
    ], 300),
    expected: 'UNCERTAIN',
  },
  {
    id: 'CORE-010',
    label: 'Autosave',
    path: '/home/user/.office/autosave',
    profile: makeProfile('/home/user/.office/autosave', 2600, 120, 18, [
      ['.tmp', 70, 1400], ['.docx', 22, 700], ['.bak', 20, 450],
    ], 45),
    expected: 'UNCERTAIN',
  },
  {
    id: 'CORE-011',
    label: 'Opaque strange name',
    path: '/home/user/.app/platanos_bananeros',
    profile: makeProfile('/home/user/.app/platanos_bananeros', 9600, 1420, 26, [
      ['.jpg', 900, 4100], ['.mp4', 110, 4700], ['.json', 220, 60],
    ], 950),
    expected: 'PROTECT',
  },
  {
    id: 'CORE-012',
    label: 'Generic runtime',
    path: '/home/user/.app/runtime',
    profile: makeProfile('/home/user/.app/runtime', 7100, 4400, 510, [
      ['.bin', 2100, 3600], ['.json', 1600, 260], ['[sin extensión]', 500, 2100],
    ], 210),
    expected: 'UNCERTAIN',
  },
];
