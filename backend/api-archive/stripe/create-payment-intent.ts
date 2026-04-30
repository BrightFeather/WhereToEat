import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { ok, err } from '../_lib/types';
import { logger, withRequestLogging } from '../_lib/logger';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

async function handler(req: VercelRequest, res: VercelResponse) {
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

  logger.request('POST', '/api/stripe/create-payment-intent', { restaurantName, amount, currency });

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // already in cents from iOS
      currency,
      payment_method_types: ['card'],
      metadata: { restaurantName },
    });

    logger.success('stripe.payment_intent.created', {
      restaurantName,
      amount,
      currency,
      paymentIntentId: paymentIntent.id,
    });

    return res.status(200).json(
      ok({
        clientSecret: paymentIntent.client_secret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      })
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Stripe error';
    logger.error('stripe.payment_intent.failed', e, { restaurantName, amount });
    return res.status(500).json(err(message, 'STRIPE_ERROR'));
  }
}
export default withRequestLogging(handler);
