import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';

// Paths that do not require authentication
const publicPaths = ['/login', '/api/auth/login', '/api/agent/'];

function isPublicPath(pathname: string): boolean {
  return publicPaths.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public Path Skip Authentication
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Static Resource Skip
  if (pathname.startsWith('/_next') || pathname.includes('.')) {
    return NextResponse.next();
  }

  // Others session token
  const token = request.cookies.get('session-vault-session')?.value;

  if (!token) {
    // API Request return 401
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    // Page request redirect to login page
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Correction token Validity
  const session = await verifyToken(token);
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'session_has_expired' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
