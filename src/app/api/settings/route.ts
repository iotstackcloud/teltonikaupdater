import { NextRequest, NextResponse } from 'next/server';
import { settingsDb } from '@/lib/db';

export async function GET() {
  try {
    const credentials = settingsDb.getGlobalCredentials();
    return NextResponse.json({
      hasGlobalCredentials: credentials !== null,
      username: credentials?.username || null
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
    const { username, password } = body as { username: string; password: string };

    if (!username || !password) {
      return NextResponse.json({
        error: 'Username and password are required'
      }, { status: 400 });
    }

    settingsDb.setGlobalCredentials(username, password);

    return NextResponse.json({
      success: true,
      message: 'Global credentials saved'
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to save settings'
    }, { status: 500 });
  }
}
