#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import yauzl from 'yauzl';
import { promisify } from 'util';
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Initialize Supabase client using your existing .env variables
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Please ensure PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY are set in your .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// CLI setup
const program = new Command();
program
  .name('upload-musicxml')
  .description('Upload a zip file containing MusicXML files to the database')
  .version('1.0.0')
  .argument('<zip-file>', 'Path to the zip file containing MusicXML files')
  .option('-b, --batch-size <size>', 'Number of files to upload in each batch', '10')
  .option('-v, --verbose', 'Verbose output')
  .parse();

const options = program.opts();
const zipFilePath = program.args[0];

// Utility function to extract zip file
async function extractZipFile(zipPath) {
  return new Promise((resolve, reject) => {
    const files = [];
    
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      
      zipfile.readEntry();
      
      zipfile.on('entry', (entry) => {
        if (options.verbose) {
          console.log(`   Found file: ${entry.fileName}`);
        }
        
        // Skip directories and non-XML files
        if (/\/$/.test(entry.fileName)) {
          if (options.verbose) {
            console.log(`   Skipping directory: ${entry.fileName}`);
          }
          zipfile.readEntry();
          return;
        }
        
        const fileName = entry.fileName.toLowerCase();
        if (!fileName.endsWith('.xml') && !fileName.endsWith('.mxl')) {
          if (options.verbose) {
            console.log(`   Skipping non-MusicXML file: ${entry.fileName}`);
          }
          zipfile.readEntry();
          return;
        }
        
        if (options.verbose) {
          console.log(`   Processing MusicXML file: ${entry.fileName}`);
        }
        
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);
          
          if (fileName.endsWith('.mxl')) {
            // Handle compressed MusicXML (.mxl) files
            const chunks = [];
            readStream.on('data', (chunk) => {
              chunks.push(chunk);
            });
            
            readStream.on('end', () => {
              const buffer = Buffer.concat(chunks);
              
              // Extract the .mxl file (which is a zip containing XML)
              yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, mxlZipfile) => {
                if (err) {
                  console.error(`   ❌ Error reading MXL file ${entry.fileName}: ${err.message}`);
                  zipfile.readEntry();
                  return;
                }
                
                mxlZipfile.readEntry();
                
                mxlZipfile.on('entry', (mxlEntry) => {
                  // Look for the main XML file (usually container.xml or score.xml)
                  if (mxlEntry.fileName.toLowerCase().endsWith('.xml') && 
                      !mxlEntry.fileName.startsWith('META-INF/')) {
                    
                    mxlZipfile.openReadStream(mxlEntry, (err, mxlReadStream) => {
                      if (err) {
                        console.error(`   ❌ Error reading XML from MXL: ${err.message}`);
                        zipfile.readEntry();
                        return;
                      }
                      
                      let xmlContent = '';
                      mxlReadStream.on('data', (chunk) => {
                        xmlContent += chunk.toString('utf8');
                      });
                      
                      mxlReadStream.on('end', () => {
                        files.push({
                          filename: entry.fileName,
                          content: xmlContent
                        });
                        zipfile.readEntry();
                      });
                    });
                    return;
                  }
                  mxlZipfile.readEntry();
                });
                
                mxlZipfile.on('end', () => {
                  // If no XML found in MXL, skip
                  zipfile.readEntry();
                });
              });
            });
          } else {
            // Handle regular XML files
            let content = '';
            readStream.on('data', (chunk) => {
              content += chunk.toString('utf8');
            });
            
            readStream.on('end', () => {
              files.push({
                filename: entry.fileName,
                content: content
              });
              zipfile.readEntry();
            });
          }
          
          readStream.on('error', reject);
        });
      });
      
      zipfile.on('end', () => {
        resolve(files);
      });
      
      zipfile.on('error', reject);
    });
  });
}

// Function to validate MusicXML content
function validateMusicXML(content) {
  // Basic validation - check if it contains MusicXML-like elements
  return content.includes('<score-partwise') || 
         content.includes('<score-timewise') ||
         content.includes('<!DOCTYPE score-partwise') ||
         content.includes('<!DOCTYPE score-timewise');
}

// Function to upload files to database in batches
async function uploadToDatabase(files, batchSize = 10) {
  console.log(`📤 Uploading ${files.length} MusicXML files to database...`);
  
  let uploaded = 0;
  let skipped = 0;
  let errors = 0;
  
  // Process files in batches
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(files.length / batchSize)} (${batch.length} files)`);
    
    const batchData = [];
    
    for (const file of batch) {
      if (options.verbose) {
        console.log(`   Validating: ${file.filename}`);
      }
      
      if (!validateMusicXML(file.content)) {
        console.log(`   ⚠️  Skipping ${file.filename} - not valid MusicXML`);
        skipped++;
        continue;
      }
      
      batchData.push({
        musicxml: file.content
      });
    }
    
    if (batchData.length === 0) {
      console.log(`   ⏭️  No valid files in this batch`);
      continue;
    }
    
    try {
      const { data, error } = await supabase
        .from('xml_pool')
        .insert(batchData);
      
      if (error) {
        console.error(`   ❌ Error uploading batch: ${error.message}`);
        if (error.message.includes('row-level security')) {
          console.error(`   💡 Tip: The xml_pool table has row-level security enabled.`);
          console.error(`       Either disable RLS for this table, or use a service role key instead of anon key.`);
        }
        errors += batchData.length;
      } else {
        console.log(`   ✅ Successfully uploaded ${batchData.length} files`);
        uploaded += batchData.length;
      }
    } catch (err) {
      console.error(`   ❌ Unexpected error: ${err.message}`);
      errors += batchData.length;
    }
    
    // Small delay between batches to avoid rate limiting
    if (i + batchSize < files.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return { uploaded, skipped, errors };
}

// Main execution
async function main() {
  try {
    // Validate zip file exists
    if (!fs.existsSync(zipFilePath)) {
      console.error(`❌ File not found: ${zipFilePath}`);
      process.exit(1);
    }
    
    console.log(`📁 Extracting MusicXML files from: ${zipFilePath}`);
    
    // Extract files from zip
    const files = await extractZipFile(zipFilePath);
    
    if (files.length === 0) {
      console.log('⚠️  No MusicXML files found in the zip archive');
      process.exit(0);
    }
    
    console.log(`🎵 Found ${files.length} XML files`);
    
    if (options.verbose) {
      console.log('\n📋 Files found:');
      files.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.filename}`);
      });
    }
    
    // Upload to database
    const batchSize = parseInt(options.batchSize);
    const results = await uploadToDatabase(files, batchSize);
    
    // Summary
    console.log('\n📊 Upload Summary:');
    console.log(`   ✅ Uploaded: ${results.uploaded} files`);
    console.log(`   ⚠️  Skipped:  ${results.skipped} files`);
    console.log(`   ❌ Errors:   ${results.errors} files`);
    console.log(`   📁 Total:    ${files.length} files`);
    
    if (results.uploaded > 0) {
      console.log('\n🎉 Upload completed successfully!');
    }
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main();
