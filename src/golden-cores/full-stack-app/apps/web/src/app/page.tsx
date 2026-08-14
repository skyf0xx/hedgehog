import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { moduleRoutes } from './module-routes';

// The index of everything built so far. `moduleRoutes` is generated from
// the route directories on disk (tools/generate-module-routes.cjs), so a
// module's screen layer only writes its own apps/web/src/app/<module>/
// and this page picks it up — no task ever edits this file, which is what
// keeps it outside every module-scoped layer's ALLOWED SCOPE.
export default function Index() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Hedgehog</h1>
        <ThemeToggle />
      </div>

      {moduleRoutes.length === 0 ? (
        <p className="text-muted-foreground max-w-prose text-center text-sm">
          No modules yet. Each one you build gets a route here.
        </p>
      ) : (
        <nav className="flex flex-wrap items-center justify-center gap-3">
          {moduleRoutes.map((route) => (
            <Button key={route.href} asChild variant="outline">
              <Link href={route.href}>{route.label}</Link>
            </Button>
          ))}
        </nav>
      )}
    </div>
  );
}
