# MusicXML Zip Upload Script

This script allows you to upload a zip file containing multiple MusicXML files to your Supabase database.

## Setup

1. **Install dependencies** (if not already installed):
   ```bash
   npm install
   ```

2. **Configure Supabase credentials**:
   - The script uses your existing `.env` file with these variables:
     ```bash
     PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
     PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
     ```
   - No additional setup needed if you already have these in your `.env` file!

## Usage

### Basic Usage
```bash
npm run upload-musicxml path/to/your/musicxml-files.zip
```

### Advanced Options
```bash
# Upload with custom batch size (default is 10)
npm run upload-musicxml -- --batch-size 20 path/to/your/files.zip

# Verbose output to see all files being processed
npm run upload-musicxml -- --verbose path/to/your/files.zip

# Combined options
npm run upload-musicxml -- --batch-size 5 --verbose path/to/your/files.zip
```

### Direct Node.js execution
```bash
node upload-musicxml.js path/to/your/files.zip
node upload-musicxml.js --help  # Show all options
```

## What it does

1. **Extracts** all `.xml` files from the zip archive
2. **Validates** each file to ensure it's valid MusicXML
3. **Uploads** files to the `xml_pool` table in batches
4. **Reports** success/failure statistics

## File Requirements

- Zip file should contain `.xml` or `.mxl` files (case-insensitive)
- `.xml` files: Uncompressed MusicXML format
- `.mxl` files: Compressed MusicXML format (automatically extracted)
- Files should be valid MusicXML format
- Files should contain `<score-partwise>` or `<score-timewise>` elements

## Database Schema

The script uploads to the `xml_pool` table with this column:
- `musicxml` (text) - The MusicXML content

## Output Example

```
📁 Extracting MusicXML files from: musicxml-collection.zip
🎵 Found 25 XML files

📤 Uploading 25 MusicXML files to database...

📦 Processing batch 1/3 (10 files)
   ✅ Successfully uploaded 10 files

📦 Processing batch 2/3 (10 files)
   ✅ Successfully uploaded 10 files

📦 Processing batch 3/3 (5 files)
   ⚠️  Skipping invalid-file.xml - not valid MusicXML
   ✅ Successfully uploaded 4 files

📊 Upload Summary:
   ✅ Uploaded: 24 files
   ⚠️  Skipped:  1 files
   ❌ Errors:   0 files
   📁 Total:    25 files

🎉 Upload completed successfully!
```

## Troubleshooting

- **File not found**: Check the zip file path
- **Database errors**: Verify your Supabase credentials and table schema
- **Invalid MusicXML**: Files must contain valid MusicXML structure
- **Rate limiting**: Use smaller batch sizes with `--batch-size` option
