<h1>Cart</h1>
<p>Total: {!! $total !!}</p>
<form method="POST" action="/cart"><input name="qty"></form>
@php $vat = $total * 0.19; @endphp
<p>VAT {{ $vat }}</p>
