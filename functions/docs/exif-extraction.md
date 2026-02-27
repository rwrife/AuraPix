# EXIF Data Extraction

## Overview

This document describes the EXIF metadata extraction implementation for AuraPix. EXIF (Exchangeable Image File Format) data is automatically extracted from uploaded images and stored alongside other photo metadata.

## Purpose

EXIF data extraction serves two primary purposes:

1. **Information Panel**: Provides rich metadata for display in the photo information panel, including camera settings, location, and technical details
2. **Search Foundation**: Enables future search functionality based on camera models, locations, dates, and other metadata fields

## Implementation

### Core Components

#### 1. EXIF Extraction Utility (`functions/src/utils/exif.ts`)

A comprehensive utility that extracts and formats EXIF data from image buffers using the `exifr` library.

**Key Features:**
- Extracts 35+ EXIF fields organized into logical categories
- Formats raw EXIF values into human-readable strings
- Handles GPS coordinates and converts to latitude/longitude
- Safely handles missing or malformed EXIF data
- Returns `null` for images without EXIF data

**Categories of Data Extracted:**

1. **Camera & Image Info**
   - Camera make and model
   - Lens make and model
   - Software used

2. **Date & Time**
   - Original capture date/time (ISO 8601 format)
   - Modification date
   - Timezone offset

3. **Image Settings**
   - Aperture (f-number)
   - Shutter speed (exposure time)
   - ISO sensitivity
   - Focal length (actual and 35mm equivalent)
   - Flash mode
   - White balance
   - Exposure mode/program
   - Metering mode
   - Exposure compensation

4. **Image Characteristics**
   - Color space (sRGB, Adobe RGB)
   - Orientation
   - Resolution (X/Y DPI)

5. **GPS Location**
   - Latitude and longitude
   - Altitude
   - Speed and direction
   - GPS timestamp

6. **Copyright & Attribution**
   - Copyright information
   - Artist/photographer
   - Image description
   - User comments

7. **Additional Technical Data**
   - Brightness, contrast, saturation, sharpness
   - Digital zoom ratio
   - Scene type and capture type
   - Subject distance

#### 2. Photo Model Update (`functions/src/models/Photo.ts`)

The `PhotoMetadata` interface now includes an optional `exif` field:

```typescript
export interface PhotoMetadata {
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  takenAt?: string;
  location?: { lat: number; lng: number };
  cameraMake?: string;
  cameraModel?: string;
  exif?: ExifData; // Complete EXIF data
}
```

#### 3. Upload Handler Integration (`functions/src/handlers/images/upload.ts`)

The upload handler automatically extracts EXIF data during image processing:

1. Image is uploaded
2. EXIF data is extracted using `extractExifData()`
3. Key fields are promoted to top-level metadata (takenAt, location, cameraMake, cameraModel)
4. Complete EXIF data is stored in `metadata.exif`
5. Photo document is saved to database with all metadata

## Data Structure

### ExifData Interface

```typescript
interface ExifData {
  // Camera & Image Info
  cameraMake?: string;
  cameraModel?: string;
  lensMake?: string;
  lensModel?: string;
  software?: string;

  // Date & Time
  takenAt?: string;
  modifiedAt?: string;
  offsetTime?: string;

  // Image Settings
  fNumber?: number;
  exposureTime?: number;
  iso?: number;
  focalLength?: number;
  focalLength35mm?: number;
  flash?: string;
  whiteBalance?: string;
  exposureMode?: string;
  exposureProgram?: string;
  meteringMode?: string;
  exposureBias?: number;

  // Image Characteristics
  colorSpace?: string;
  orientation?: number;
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
```

## Usage Examples

### Accessing EXIF Data in Code

```typescript
// Get photo document
const photo = await dataAdapter.getData('photos', photoId);

// Access specific EXIF fields
const cameraMake = photo.metadata.exif?.cameraMake;
const iso = photo.metadata.exif?.iso;
const exposureTime = photo.metadata.exif?.exposureTime;

// Check if photo has GPS data
if (photo.metadata.exif?.gps) {
  const { latitude, longitude } = photo.metadata.exif.gps;
  console.log(`Photo taken at: ${latitude}, ${longitude}`);
}

// Check camera settings
if (photo.metadata.exif) {
  const { fNumber, exposureTime, iso, focalLength } = photo.metadata.exif;
  console.log(`Settings: f/${fNumber}, ${exposureTime}s, ISO ${iso}, ${focalLength}mm`);
}
```

### Display in Information Panel

The EXIF data can be displayed in various ways:

```typescript
// Camera Information Section
if (photo.metadata.exif?.cameraMake) {
  display(`Camera: ${photo.metadata.exif.cameraMake} ${photo.metadata.exif.cameraModel}`);
}

// Capture Settings Section
const settings = [
  photo.metadata.exif?.fNumber && `f/${photo.metadata.exif.fNumber}`,
  photo.metadata.exif?.exposureTime && `1/${1/photo.metadata.exif.exposureTime}s`,
  photo.metadata.exif?.iso && `ISO ${photo.metadata.exif.iso}`,
  photo.metadata.exif?.focalLength && `${photo.metadata.exif.focalLength}mm`,
].filter(Boolean).join(' · ');

// Location Section
if (photo.metadata.location) {
  displayMap(photo.metadata.location.lat, photo.metadata.location.lng);
}
```

## Future Enhancements

### Search Capabilities

The stored EXIF data enables powerful search features:

1. **Camera-based search**: Find all photos taken with a specific camera or lens
2. **Settings-based search**: Find photos with specific aperture, ISO, or focal length ranges
3. **Location-based search**: Find photos taken within a geographic area
4. **Date/time search**: Enhanced date filtering using EXIF capture time
5. **Technical search**: Find photos with specific color spaces, orientations, or scene types

### Example Search Queries

```typescript
// Find all photos from a Canon camera
await searchPhotos({ 'metadata.exif.cameraMake': 'Canon' });

// Find portraits (wide aperture)
await searchPhotos({ 'metadata.exif.fNumber': { $lte: 2.8 } });

// Find photos taken in a specific location (within radius)
await searchPhotos({
  'metadata.exif.gps.latitude': { $gte: lat - delta, $lte: lat + delta },
  'metadata.exif.gps.longitude': { $gte: lng - delta, $lte: lng + delta }
});

// Find night photography (high ISO)
await searchPhotos({ 'metadata.exif.iso': { $gte: 1600 } });
```

## Testing

Tests are provided in `functions/test/utils/exif.test.ts` to verify:

- EXIF extraction from various image formats
- Graceful handling of invalid or missing EXIF data
- Correct TypeScript type definitions
- Proper structure of extracted data

Run tests with:
```bash
cd functions
npm test exif
```

## Dependencies

- **exifr**: Modern, lightweight EXIF extraction library
  - Supports all major image formats
  - Fast and efficient
  - Well-maintained and actively developed
  - Comprehensive EXIF tag support

## Performance Considerations

- EXIF extraction is performed during upload, not on every read
- Extraction is fast (typically < 100ms per image)
- Data is stored once and read many times
- No impact on image serving performance
- GPS parsing is optimized for common formats

## Security & Privacy

- EXIF data may contain sensitive information (GPS location, camera serial numbers)
- Consider implementing privacy controls to:
  - Strip GPS data on share/export if user prefers
  - Allow users to view/edit EXIF data before sharing
  - Provide options to remove specific EXIF fields
  - Warn users when sharing photos with location data

## Troubleshooting

### No EXIF Data Extracted

Possible causes:
- Image format doesn't support EXIF (e.g., some PNGs, GIFs)
- EXIF data was previously stripped
- Image was processed/edited without preserving EXIF
- Camera doesn't write EXIF data

### Incorrect or Missing GPS Data

- GPS must be enabled on the camera/device during capture
- Some devices write GPS in non-standard formats
- GPS accuracy depends on device capabilities

### Date/Time Issues

- Camera clock may be set incorrectly
- Timezone information may be missing
- Date format can vary by camera manufacturer