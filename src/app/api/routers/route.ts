import { NextRequest, NextResponse } from 'next/server';
import { routerDb, settingsDb } from '@/lib/db';
import { checkRouterConnectivity, getFirmwareInfo } from '@/lib/ssh-service';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status');

    let routers;
    if (status) {
      routers = routerDb.getByStatus(status);
    } else {
      routers = routerDb.getAll();
    }

    const stats = routerDb.countByStatus();

    return NextResponse.json({
      routers,
      stats,
      total: routers.length
    });
  } catch (error) {
    console.error('Error fetching routers:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to fetch routers'
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    routerDb.deleteAll();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to delete routers'
    }, { status: 500 });
  }
}
