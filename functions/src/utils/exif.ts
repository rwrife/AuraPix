import exifr from 'exifr';
import { logger } from './logger.js';

/**
 * Complete EXIF data structure with all important metadata fields
 */
export interface ExifData {
  // Camera & Image Info
  cameraMake?: string;
  cameraModel?: string;
  lensMake?: string;
  lensModel?: string;
  software?: string;

  // Date & Time
  takenAt?: string; // ISO 8601 datetime
  modifiedAt?: string;
  offsetTime?: string; // Timezone offset

  // Image Settings
  fNumber?: number; // Aperture (e.g., 2.8)
  exposureTime?: number; // Shutter speed in seconds (e.g., 0.008 = 1/125)
  iso?: number;
  focalLength?: number; // in mm
  focalLength35mm?: number; // 35mm equivalent
  flash?: string;
  whiteBalance?: string;
  exposureMode?: string;
  exposureProgram?: string;
  meteringMode?: string;
  exposureBias?: number;

  // Image Characteristics
  colorSpace?: string;
  orientation?: number; // 1-8, EXIF orientation
  xResolution?: number;
  yResolution?: number;
  resolutionUnit?: string;

  // GPS Location
  gps?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
    altitudeRef?: number;
    speed?: number;
    speedRef?: string;
    direction?: number;
    directionRef?: string;
    timestamp?: string;
  };

  // Copyright & Attribution
  copyright?: string;
  artist?: string;
  imageDescription?: string;
  userComment?: string;

  // Additional Technical Data
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  digitalZoomRatio?: number;
  sceneType?: string;
  sceneCaptureType?: string;
  subjectDistance?: number;
  subjectDistanceRange?: string;
}

/**
 * Extract comprehensive EXIF data from image buffer
 */
export async function extractExifData(
  imageBuffer: Buffer
): Promise<ExifData | null> {
  try {
    // Parse all available EXIF data with exifr
    // exifr options: https://github.com/MikeKovarik/exifr
    const raw = await exifr.parse(imageBuffer, {
      // Enable specific IFD blocks
      ifd0: true, // Basic EXIF
      ifd1: true, // Thumbnail
      exif: true, // Extended EXIF
      gps: true, // GPS data
      interop: true, // Interoperability
      makerNote: false, // Skip proprietary maker notes for now
      userComment: true,
      mergeOutput: true, // Merge all IFDs into single object
    } as any);

    if (!raw) {
      logger.debug('No EXIF data found in image');
      return null;
    }

    // Map raw EXIF to our structured format
    const exifData: ExifData = {
      // Camera & Image Info
      cameraMake: cleanString(raw.Make),
      cameraModel: cleanString(raw.Model),
      lensMake: cleanString(raw.LensMake),
      lensModel: cleanString(raw.LensModel),
      software: cleanString(raw.Software),

      // Date & Time
      takenAt: formatDateTime(raw.DateTimeOriginal || raw.CreateDate),
      modifiedAt: formatDateTime(raw.ModifyDate),
      offsetTime: raw.OffsetTime || raw.OffsetTimeOriginal,

      // Image Settings
      fNumber: raw.FNumber,
      exposureTime: raw.ExposureTime,
      iso: raw.ISO,
      focalLength: raw.FocalLength,
      focalLength35mm: raw.FocalLengthIn35mmFormat,
      flash: formatFlash(raw.Flash),
      whiteBalance: formatWhiteBalance(raw.WhiteBalance),
      exposureMode: formatExposureMode(raw.ExposureMode),
      exposureProgram: formatExposureProgram(raw.ExposureProgram),
      meteringMode: formatMeteringMode(raw.MeteringMode),
      exposureBias: raw.ExposureCompensation,

      // Image Characteristics
      colorSpace: formatColorSpace(raw.ColorSpace),
      orientation: raw.Orientation,
      xResolution: raw.XResolution,
      yResolution: raw.YResolution,
      resolutionUnit: formatResolutionUnit(raw.ResolutionUnit),

      // GPS Location
      gps: extractGpsData(raw),

      // Copyright & Attribution
      copyright: cleanString(raw.Copyright),
      artist: cleanString(raw.Artist),
      imageDescription: cleanString(raw.ImageDescription),
      userComment: cleanString(raw.UserComment),

      // Additional Technical Data
      brightness: raw.BrightnessValue,
      contrast: formatContrast(raw.Contrast),
      saturation: formatSaturation(raw.Saturation),
      sharpness: formatSharpness(raw.Sharpness),
      digitalZoomRatio: raw.DigitalZoomRatio,
      sceneType: formatSceneType(raw.SceneType),
      sceneCaptureType: formatSceneCaptureType(raw.SceneCaptureType),
      subjectDistance: raw.SubjectDistance,
      subjectDistanceRange: formatSubjectDistanceRange(
        raw.SubjectDistanceRange
      ),
    };

    // Remove undefined values for cleaner storage
    const cleaned = removeUndefined(exifData);

    logger.debug(
      {
        fieldsFound: Object.keys(cleaned).length,
        hasGps: !!cleaned.gps,
      },
      'Extracted EXIF data'
    );

    return cleaned;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to extract EXIF data');
    return null;
  }
}

/**
 * Extract GPS coordinates and related data
 */
function extractGpsData(raw: any): ExifData['gps'] | undefined {
  if (!raw.latitude || !raw.longitude) {
    return undefined;
  }

  return removeUndefined({
    latitude: raw.latitude,
    longitude: raw.longitude,
    altitude: raw.GPSAltitude,
    altitudeRef: raw.GPSAltitudeRef,
    speed: raw.GPSSpeed,
    speedRef: raw.GPSSpeedRef,
    direction: raw.GPSImgDirection,
    directionRef: raw.GPSImgDirectionRef,
    timestamp: raw.GPSDateStamp
      ? `${raw.GPSDateStamp}T${raw.GPSTimeStamp || '00:00:00'}Z`
      : undefined,
  });
}

/**
 * Format DateTime to ISO 8601 string
 */
function formatDateTime(date: any): string | undefined {
  if (!date) return undefined;

  try {
    if (date instanceof Date) {
      return date.toISOString();
    }
    if (typeof date === 'string') {
      // Try to parse strings like "2023:12:25 14:30:00"
      const parsed = new Date(date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
      return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format flash mode
 */
function formatFlash(flash: any): string | undefined {
  if (flash === undefined || flash === null) return undefined;

  const flashModes: Record<number, string> = {
    0: 'No Flash',
    1: 'Fired',
    5: 'Fired, Return not detected',
    7: 'Fired, Return detected',
    8: 'On, Did not fire',
    9: 'On, Fired',
    13: 'On, Return not detected',
    15: 'On, Return detected',
    16: 'Off, Did not fire',
    20: 'Off, Did not fire, Return not detected',
    24: 'Auto, Did not fire',
    25: 'Auto, Fired',
    29: 'Auto, Fired, Return not detected',
    31: 'Auto, Fired, Return detected',
    32: 'No flash function',
    48: 'Off, No flash function',
    65: 'Fired, Red-eye reduction',
    69: 'Fired, Red-eye reduction, Return not detected',
    71: 'Fired, Red-eye reduction, Return detected',
    73: 'On, Red-eye reduction',
    77: 'On, Red-eye reduction, Return not detected',
    79: 'On, Red-eye reduction, Return detected',
    89: 'Auto, Fired, Red-eye reduction',
    93: 'Auto, Fired, Red-eye reduction, Return not detected',
    95: 'Auto, Fired, Red-eye reduction, Return detected',
  };

  return flashModes[flash] || `Unknown (${flash})`;
}

function formatWhiteBalance(wb: any): string | undefined {
  if (wb === undefined) return undefined;
  const modes: Record<number, string> = {
    0: 'Auto',
    1: 'Manual',
  };
  return modes[wb] || `Unknown (${wb})`;
}

function formatExposureMode(mode: any): string | undefined {
  if (mode === undefined) return undefined;
  const modes: Record<number, string> = {
    0: 'Auto',
    1: 'Manual',
    2: 'Auto bracket',
  };
  return modes[mode] || `Unknown (${mode})`;
}

function formatExposureProgram(program: any): string | undefined {
  if (program === undefined) return undefined;
  const programs: Record<number, string> = {
    0: 'Not defined',
    1: 'Manual',
    2: 'Normal program',
    3: 'Aperture priority',
    4: 'Shutter priority',
    5: 'Creative program',
    6: 'Action program',
    7: 'Portrait mode',
    8: 'Landscape mode',
  };
  return programs[program] || `Unknown (${program})`;
}

function formatMeteringMode(mode: any): string | undefined {
  if (mode === undefined) return undefined;
  const modes: Record<number, string> = {
    0: 'Unknown',
    1: 'Average',
    2: 'Center-weighted average',
    3: 'Spot',
    4: 'Multi-spot',
    5: 'Pattern',
    6: 'Partial',
    255: 'Other',
  };
  return modes[mode] || `Unknown (${mode})`;
}

function formatColorSpace(space: any): string | undefined {
  if (space === undefined) return undefined;
  const spaces: Record<number, string> = {
    1: 'sRGB',
    2: 'Adobe RGB',
    65535: 'Uncalibrated',
  };
  return spaces[space] || `Unknown (${space})`;
}

function formatResolutionUnit(unit: any): string | undefined {
  if (unit === undefined) return undefined;
  const units: Record<number, string> = {
    2: 'inches',
    3: 'centimeters',
  };
  return units[unit] || `Unknown (${unit})`;
}

function formatContrast(contrast: any): number | undefined {
  if (contrast === undefined) return undefined;
  return contrast;
}

function formatSaturation(saturation: any): number | undefined {
  if (saturation === undefined) return undefined;
  return saturation;
}

function formatSharpness(sharpness: any): number | undefined {
  if (sharpness === undefined) return undefined;
  return sharpness;
}

function formatSceneType(type: any): string | undefined {
  if (type === undefined) return undefined;
  return type === 1 ? 'Directly photographed' : `Unknown (${type})`;
}

function formatSceneCaptureType(type: any): string | undefined {
  if (type === undefined) return undefined;
  const types: Record<number, string> = {
    0: 'Standard',
    1: 'Landscape',
    2: 'Portrait',
    3: 'Night scene',
  };
  return types[type] || `Unknown (${type})`;
}

function formatSubjectDistanceRange(range: any): string | undefined {
  if (range === undefined) return undefined;
  const ranges: Record<number, string> = {
    0: 'Unknown',
    1: 'Macro',
    2: 'Close',
    3: 'Distant',
  };
  return ranges[range] || `Unknown (${range})`;
}

/**
 * Clean string by trimming and removing null bytes
 */
function cleanString(str: any): string | undefined {
  if (typeof str !== 'string') return undefined;
  const cleaned = str.replace(/\0/g, '').trim();
  return cleaned || undefined;
}

/**
 * Remove undefined values from object recursively
 */
function removeUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: any = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = removeUndefined(value);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}