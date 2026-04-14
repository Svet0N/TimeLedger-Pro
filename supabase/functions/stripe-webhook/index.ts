import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
    apiVersion: '2022-11-15',
    httpClient: Stripe.createFetchHttpClient(),
  });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const signature = req.headers.get('stripe-signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const body = await req.text();

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log(`Processing event: ${event.type}`);

  // Helper: update subscription_status by customer ID
  async function updateStatusByCustomer(customerId: string, stripeStatus: string) {
    // trialing and active both grant full access
    const status = ['active', 'trialing'].includes(stripeStatus) ? 'active' : 'inactive';
    const { error } = await supabase
      .from('user_profiles')
      .update({ subscription_status: status })
      .eq('stripe_customer_id', customerId);

    if (error) console.error(`Failed to update status for customer ${customerId}:`, error);
    else console.log(`Set status='${status}' (stripe: '${stripeStatus}') for customer ${customerId}`);
  }

  try {
    switch (event.type) {

      // ── Checkout completed ──────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.supabase_user_id;
        const customerId = session.customer as string;

        if (userId && customerId) {
          await supabase
            .from('user_profiles')
            .update({
              stripe_customer_id: customerId,
              subscription_status: 'active',
            })
            .eq('id', userId);
          console.log(`Activated subscription for user ${userId}`);
        }
        break;
      }

      // ── Subscription created (handles new trials immediately) ───────
      case 'customer.subscription.created': {
        const sub = event.data.object as Stripe.Subscription;
        await updateStatusByCustomer(sub.customer as string, sub.status);
        break;
      }

      // ── Subscription updated (plan changes, trial end, cancellations)
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await updateStatusByCustomer(sub.customer as string, sub.status);
        break;
      }

      // ── Subscription deleted/cancelled ──────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        await supabase
          .from('user_profiles')
          .update({ subscription_status: 'inactive' })
          .eq('stripe_customer_id', customerId);

        console.log(`Deactivated subscription for customer ${customerId}`);
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error('Event processing error:', err);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
});
