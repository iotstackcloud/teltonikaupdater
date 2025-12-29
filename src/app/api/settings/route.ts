import { NextRequest, NextResponse } from 'next/server';
import { settingsDb } from '@/lib/db';

export async function GET() {
  try {
    const credentials = settingsDb.getGlobalCredentials();
    const batchWaitTime = settingsDb.getBatchWaitTime();

    return NextResponse.json({
      hasGlobalCredentials: credentials !== null,
      username: credentials?.username || null,
      batchWaitTime
      // Don't return password for security
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to get settings'
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password, batchWaitTime } = body as {
      username?: string;
      password?: string;
      batchWaitTime?: number;
    };

    // Save credentials if provided
    if (username && password) {
      settingsDb.setGlobalCredentials(username, password);
    }

    // Save batch wait time if provided
    if (batchWaitTime !== undefined) {
      settingsDb.setBatchWaitTime(batchWaitTime);
    }

    return NextResponse.json({
      success: true,
      message: 'Settings saved'
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to save settings'
    }, { status: 500 });
  }
}
