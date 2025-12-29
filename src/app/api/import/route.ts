import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { routerDb, settingsDb } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const clearExisting = formData.get('clearExisting') === 'true';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Read Excel file
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as string[][];

    if (data.length < 2) {
      return NextResponse.json({ error: 'Excel file is empty or has no data rows' }, { status: 400 });
    }

    // Parse headers (first row)
    const headers = data[0].map((h: string) => h?.toString().toLowerCase().trim());

    // Find column indices
    const deviceNameIdx = headers.findIndex((h: string) =>
      h?.includes('gerätename') || h?.includes('geratename') || h?.includes('device') || h?.includes('name')
    );
    const ipAddressIdx = headers.findIndex((h: string) =>
      h?.includes('ip') || h?.includes('adresse') || h?.includes('address')
    );
    const userIdx = headers.findIndex((h: string) =>
      h?.includes('user') || h?.includes('benutzer')
    );
    const passwordIdx = headers.findIndex((h: string) =>
      h?.includes('pass') || h?.includes('kennwort')
    );

    if (deviceNameIdx === -1 || ipAddressIdx === -1) {
      return NextResponse.json({
        error: 'Required columns not found. Need "Gerätename" and "IP-Adresse"'
      }, { status: 400 });
    }

    // Get global credentials as fallback
    const globalCreds = settingsDb.getGlobalCredentials();

    // Clear existing routers if requested
    if (clearExisting) {
      routerDb.deleteAll();
    }

    // Parse data rows
    const routers = [];
    const errors = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      const deviceName = row[deviceNameIdx]?.toString().trim();
      const ipAddress = row[ipAddressIdx]?.toString().trim();
      const username = userIdx >= 0 ? row[userIdx]?.toString().trim() : null;
      const password = passwordIdx >= 0 ? row[passwordIdx]?.toString().trim() : null;

      if (!deviceName || !ipAddress) {
        errors.push({ row: i + 1, error: 'Missing device name or IP address' });
        continue;
      }

      // Validate IP address format
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipRegex.test(ipAddress)) {
        errors.push({ row: i + 1, error: `Invalid IP address: ${ipAddress}` });
        continue;
      }

      routers.push({
        id: uuidv4(),
        device_name: deviceName,
        ip_address: ipAddress,
        username: username || globalCreds?.username || null,
        password: password || globalCreds?.password || null,
        status: 'unknown'
      });
    }

    // Insert routers into database
    if (routers.length > 0) {
      routerDb.insertMany(routers);
    }

    return NextResponse.json({
      success: true,
      imported: routers.length,
      errors: errors.length > 0 ? errors : undefined,
      total: data.length - 1
    });
  } catch (error) {
    console.error('Import error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Import failed'
    }, { status: 500 });
  }
}
