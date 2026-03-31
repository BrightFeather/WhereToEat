import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { ok, err } from '../_lib/types';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { amount, currency = 'usd', restaurantName } = req.body as {
    amount: number;
    currency?: string;
    restaurantName: string;
  };

  if (!amount || amount <= 0) {
    return res.status(400).json(err('Invalid amount', 'INVALID_AMOUNT'));
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // already in cents from iOS
      currency,
      payment_method_types: ['card'],
      metadata: { restaurantName },
    });

    return res.status(200).json(
      ok({
        clientSecret: paymentIntent.client_secret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      })
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Stripe error';
    console.error('Stripe error:', e);
    return res.status(500).json(err(message, 'STRIPE_ERROR'));
  }
}
