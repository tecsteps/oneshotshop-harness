<?php

namespace OneShotShop\PerfProbe;

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Http\Events\RequestHandled;
use Illuminate\Support\ServiceProvider;

/**
 * Harness-owned probe. Records one JSON line per HTTP request handled by Laravel into
 * storage/perf/requests.jsonl. Active only when storage/perf/ENABLED exists and the app is not
 * running in the console, so installing it never changes CLI behaviour (migrate, seed, tests).
 * Env vars are deliberately not used: `php artisan serve` does not pass custom env vars to
 * the PHP built-in server process.
 */
class PerfProbeServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(Recorder::class, fn () => new Recorder());
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([ExplainCommand::class]);
            return;
        }
        if (! is_file(storage_path('perf/ENABLED'))) {
            return;
        }
        /** @var Recorder $rec */
        $rec = $this->app->make(Recorder::class);
        $rec->start();

        $this->app['events']->listen(QueryExecuted::class, function (QueryExecuted $e) use ($rec) {
            $rec->query($e);
        });
        $this->app['events']->listen(RequestHandled::class, function (RequestHandled $e) use ($rec) {
            $rec->handled($e->request, $e->response);
        });
        $this->app->terminating(function () use ($rec) {
            $rec->flush();
        });
    }
}
