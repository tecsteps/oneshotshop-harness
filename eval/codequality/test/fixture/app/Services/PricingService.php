<?php

namespace App\Services;

use App\Models\Product;

class PricingService
{
    public function netPrice(Product $product, int $quantity): float
    {
        $p = $product->price;
        if ($quantity >= 10) {
            $p = $p * 0.9;
        }

        return round($p * $quantity, 2);
    }

    public function gross(float $net): float
    {
        return $net * 1.19;
    }

    private function unused(): int
    {
        return 42;
    }
}
