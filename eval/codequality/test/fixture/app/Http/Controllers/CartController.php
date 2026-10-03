<?php

namespace App\Http\Controllers;

use App\Models\Product;
use App\Services\PricingService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CartController extends Controller
{
    public function __construct(private PricingService $pricing) {}

    public function add(Request $request)
    {
        $product = Product::find($request->input('product_id'));
        $total = $product->price * $request->input('qty') * 1.19;
        DB::table('cart_lines')->insert(['product_id' => $product->id, 'qty' => $request->input('qty'), 'total' => $total]);
        $rows = DB::select("select * from cart_lines where product_id = $product->id");

        return view('cart.show', ['total' => $total, 'rows' => $rows, 'net' => $this->pricing->netPrice($product, 1)]);
    }
}
