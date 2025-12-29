import { NextRequest, NextResponse } from 'next/server';
import { firmwareVersionDb } from '@/lib/db';

export async function GET() {
  try {
    const versions = firmwareVersionDb.getAll();
    return NextResponse.json({ versions });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to get firmware versions'
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { device_prefix, latest_version } = body as { device_prefix?: string; latest_version?: string };

    if (!device_prefix || !latest_version) {
      return NextResponse.json({
        error: 'device_prefix and latest_version are required'
      }, { status: 400 });
    }

    // Validate format (e.g., RUT9, RUT2, RUTX, TRB1)
    if (!/^[A-Z0-9]+$/.test(device_prefix)) {
      return NextResponse.json({
        error: 'Invalid device_prefix format. Use uppercase letters and numbers only (e.g., RUT9, RUT2, RUTX)'
      }, { status: 400 });
    }

    // Validate version format (e.g., RUT9_R_00.07.06.20)
    if (!/^[A-Z0-9]+_R_\d+\.\d+\.\d+\.\d+$/.test(latest_version)) {
      return NextResponse.json({
        error: 'Invalid version format. Expected format: XXX_R_00.00.00.00 (e.g., RUT9_R_00.07.06.20)'
      }, { status: 400 });
    }

    firmwareVersionDb.upsert(device_prefix, latest_version);

    return NextResponse.json({
      success: true,
      message: `Firmware version for ${device_prefix} set to ${latest_version}`
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to save firmware version'
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const prefix = searchParams.get('prefix');

    if (!prefix) {
      return NextResponse.json({
        error: 'prefix parameter is required'
      }, { status: 400 });
    }

    firmwareVersionDb.delete(prefix);

    return NextResponse.json({
      success: true,
      message: `Firmware version for ${prefix} deleted`
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to delete firmware version'
    }, { status: 500 });
  }
}
