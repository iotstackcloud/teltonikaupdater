import { NextRequest, NextResponse } from 'next/server';
import { updateHistoryDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const routerId = searchParams.get('routerId');
    const limit = parseInt(searchParams.get('limit') || '50');

    let history;
    if (routerId) {
      history = updateHistoryDb.getByRouter(routerId);
    } else {
      history = updateHistoryDb.getRecent(limit);
    }

    return NextResponse.json({ history });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to get history'
    }, { status: 500 });
  }
}
