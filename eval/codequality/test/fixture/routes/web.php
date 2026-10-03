<?php

use App\Http\Controllers\CartController;
use Illuminate\Support\Facades\Route;

Route::post('/cart', [CartController::class, 'add']);
Route::get('/hello', function () { $x = env('APP_NAME'); return strtoupper($x); });
