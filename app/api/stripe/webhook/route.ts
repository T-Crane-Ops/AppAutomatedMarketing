import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { supabaseAdmin } from '@/utils/supabase-admin';
import { withCors } from '@/utils/cors';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// Helper function for consistent logging
function logWebhookEvent(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] WEBHOOK: ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// Define interfaces for stored data
interface StoredSessionData {
  userId: string;
  customerId: string;
}

interface StoredSubscriptionData {
  id: string;
  customer: string;
}

// Store both checkout sessions and subscriptions temporarily
const checkoutSessionMap = new Map<string, StoredSessionData>();
const pendingSubscriptions = new Map<string, StoredSubscriptionData>();

// Need to disable body parsing for Stripe webhooks
export const config = {
  api: {
    bodyParser: false,
  },
};

async function checkExistingSubscription(customerId: string): Promise<boolean> {
  const { data: existingSubs } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('stripe_customer_id', customerId)
    .in('status', ['active', 'trialing'])
    .single();

  return !!existingSubs;
}

// Helper function to find user ID by email
async function findUserIdByEmail(email: string): Promise<string | null> {
  logWebhookEvent('Looking up user by email', { email });
  
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .ilike('email', email)
      .single();
    
    if (error || !data) {
      logWebhookEvent('No user found with email', { email, error });
      return null;
    }
    
    logWebhookEvent('Found user by email', { email, userId: data.id });
    return data.id;
  } catch (error) {
    logWebhookEvent('Error looking up user by email', { email, error });
    return null;
  }
}

// Currently Handled Events:
// 1. checkout.session.completed - When a customer completes checkout
// 2. customer.subscription.created - When a new subscription is created
// 3. customer.subscription.updated - When a subscription is updated
// 4. customer.subscription.deleted - When a subscription is cancelled/deleted
// 5. customer.subscription.pending_update_applied - When a pending update is applied
// 6. customer.subscription.pending_update_expired - When a pending update expires
// 7. customer.subscription.trial_will_end - When a trial is about to end

// Other Important Events You Might Want to Handle:
// Payment Related:
// - invoice.paid - When an invoice is paid successfully
// - invoice.payment_failed - When a payment fails
// - invoice.upcoming - When an invoice is going to be created
// - payment_intent.succeeded - When a payment is successful
// - payment_intent.payment_failed - When a payment fails

// Customer Related:
// - customer.created - When a new customer is created
// - customer.updated - When customer details are updated
// - customer.deleted - When a customer is deleted

// Subscription Related:
// - customer.subscription.paused - When a subscription is paused
// - customer.subscription.resumed - When a subscription is resumed
// - customer.subscription.trial_will_end - 3 days before trial ends

// Checkout Related:
// - checkout.session.async_payment_succeeded - Async payment success
// - checkout.session.async_payment_failed - Async payment failure
// - checkout.session.expired - When checkout session expires

export const POST = withCors(async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature')!;

  try {
    logWebhookEvent('Received webhook request');
    logWebhookEvent('Stripe signature', sig);

    let event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
      logWebhookEvent(`Event received: ${event.type}`, { 
        eventType: event.type,
        objectId: typeof event.data.object === 'object' && 'id' in event.data.object ? event.data.object.id : undefined,
        objectType: typeof event.data.object === 'object' && 'object' in event.data.object ? event.data.object.object : undefined
      });
    } catch (err) {
      const error = err as Error;
      logWebhookEvent('Error constructing Stripe event', { error: error.message, sig });
      return NextResponse.json({ error: 'Webhook signature verification failed' }, { status: 400 });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        logWebhookEvent('Processing checkout.session.completed', {
          sessionId: session.id,
          clientReferenceId: session.client_reference_id,
          customerId: session.customer,
          subscriptionId: session.subscription,
          customerEmail: session.customer_details?.email || session.customer_email,
          paymentStatus: session.payment_status
        });

        // Required fields validation
        if (!session.subscription) {
          logWebhookEvent('Missing subscription in session', session);
          return NextResponse.json({ error: 'Missing subscription ID' }, { status: 400 });
        }

        if (!session.customer) {
          logWebhookEvent('Missing customer in session', session);
          return NextResponse.json({ error: 'Missing customer ID' }, { status: 400 });
        }

        // Try to find user ID - first from client_reference_id, then from email
        let userId = session.client_reference_id || '';
        
        // If there's no client_reference_id or it doesn't look like a valid UUID, try to look up by email
        if (!userId || !userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          logWebhookEvent('Invalid or missing client_reference_id, trying to find user by email', { 
            clientReferenceId: userId,
            customerEmail: session.customer_details?.email || session.customer_email 
          });
          
          const email = session.customer_details?.email || session.customer_email;
          if (email) {
            const foundUserId = await findUserIdByEmail(email);
            if (foundUserId) {
              userId = foundUserId;
              logWebhookEvent('Found user ID by email', { email, userId });
            } else {
              logWebhookEvent('No user found with this email', { email });
              
              // Attempt to get all users for debugging
              const { data: allUsers } = await supabaseAdmin
                .from('users')
                .select('id, email')
                .limit(10);
              
              logWebhookEvent('First 10 users in database for debugging', { users: allUsers });
              return NextResponse.json({ error: 'User not found' }, { status: 400 });
            }
          } else {
            logWebhookEvent('No email available to look up user', session);
            return NextResponse.json({ error: 'No email to identify user' }, { status: 400 });
          }
        }

        // Validate the userId exists in the database
        try {
          const { data: userExists } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('id', userId)
            .single();
          
          if (!userExists) {
            logWebhookEvent('User ID not found in database', { userId });
            
            // If user ID not found, try one more time to find by email
            const email = session.customer_details?.email || session.customer_email;
            if (email) {
              const foundUserId = await findUserIdByEmail(email);
              if (foundUserId) {
                userId = foundUserId;
                logWebhookEvent('Found alternative user ID by email', { email, userId });
              } else {
                return NextResponse.json({ error: 'User ID not valid' }, { status: 400 });
              }
            } else {
              return NextResponse.json({ error: 'User ID not valid and no email to retry' }, { status: 400 });
            }
          } else {
            logWebhookEvent('Confirmed user ID exists in database', { userId });
          }
        } catch (error) {
          logWebhookEvent('Error validating user ID', { userId, error });
        }

        // Check for existing active subscription
        try {
          const hasActiveSubscription = await checkExistingSubscription(session.customer as string);
          
          if (hasActiveSubscription) {
            logWebhookEvent('Duplicate subscription attempt blocked', {
              customerId: session.customer,
              sessionId: session.id
            });
            
            // Cancel the new subscription immediately
            if (session.subscription) {
              await stripe.subscriptions.cancel(session.subscription as string);
              logWebhookEvent('Cancelled duplicate subscription', { subscriptionId: session.subscription });
            }
            
            return NextResponse.json({ 
              status: 'blocked',
              message: 'Customer already has an active subscription'
            });
          }

          logWebhookEvent('Creating subscription record', {
            userId,
            customerId: session.customer as string,
            subscriptionId: session.subscription as string
          });

          try {
            const subscription = await createSubscription(
              session.subscription as string,
              userId,
              session.customer as string
            );
            logWebhookEvent('Successfully created subscription', subscription);
          } catch (subError) {
            logWebhookEvent('Failed to create subscription', subError);
            
            // Try to get more information about what went wrong
            try {
              const stripeSubscription = await stripe.subscriptions.retrieve(session.subscription as string);
              logWebhookEvent('Subscription info from Stripe', { 
                status: stripeSubscription.status,
                customer: stripeSubscription.customer,
                items: stripeSubscription.items.data.map(item => ({ 
                  price: item.price.id,
                  quantity: item.quantity
                }))
              });
            } catch (retrieveError) {
              logWebhookEvent('Failed to retrieve subscription from Stripe', retrieveError);
            }
            
            throw subError;
          }
        } catch (error) {
          logWebhookEvent('Failed to process checkout.session.completed', error);
          // Don't throw here, just log the error and return success to avoid webhook retries
          return NextResponse.json({ received: true, warning: 'Error processing checkout session' });
        }
        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // Check if we have the session data already
        const sessionData = checkoutSessionMap.get(subscription.id);
        if (sessionData) {
          // We can create the subscription now
          await createSubscription(
            subscription.id,
            sessionData.userId,
            sessionData.customerId
          );
          checkoutSessionMap.delete(subscription.id);
        } else {
          // Store the subscription data until we get the session
          pendingSubscriptions.set(subscription.id, {
            id: subscription.id,
            customer: subscription.customer as string
          });
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.pending_update_applied':
      case 'customer.subscription.pending_update_expired':
      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status,
            cancel_at_period_end: subscription.cancel_at_period_end,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: subscription.status,
            cancel_at_period_end: false,
            current_period_end: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('stripe_subscription_id', subscription.id);
        
        break;
      }

      // Note: You might want to add handlers for these common events:
      // case 'invoice.paid': {
      //   const invoice = event.data.object as Stripe.Invoice;
      //   // Handle successful payment
      // }

      // case 'invoice.payment_failed': {
      //   const invoice = event.data.object as Stripe.Invoice;
      //   // Handle failed payment, notify user
      // }

      // case 'customer.subscription.trial_will_end': {
      //   const subscription = event.data.object as Stripe.Subscription;
      //   // Notify user about trial ending
      // }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    const error = err as Error;
    logWebhookEvent('Webhook error', error);
    return NextResponse.json(
      { error: 'Webhook handler failed', message: error.message },
      { status: 400 }
    );
  }
});

async function createSubscription(subscriptionId: string, userId: string, customerId: string) {
  logWebhookEvent('Starting createSubscription', { subscriptionId, userId, customerId });

  try {
    // Validate inputs
    if (!subscriptionId || !userId || !customerId) {
      logWebhookEvent('Missing required parameters for createSubscription', { 
        subscriptionId, 
        userId, 
        customerId,
        hasSubscriptionId: !!subscriptionId,
        hasUserId: !!userId,
        hasCustomerId: !!customerId 
      });
      throw new Error('Missing required parameters for createSubscription');
    }

    // Check if userId exists in the users table
    const { data: userExists, error: userError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (userError || !userExists) {
      logWebhookEvent('User ID not found in database', { userId, error: userError });
      throw new Error(`User ID ${userId} not found in database`);
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    logWebhookEvent('Retrieved Stripe subscription', stripeSubscription);

    const { data: existingData, error: checkError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', subscriptionId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {  // PGRST116 is "no rows returned"
      logWebhookEvent('Error checking existing subscription', checkError);
      throw checkError;
    }

    if (existingData) {
      logWebhookEvent('Found existing subscription', existingData);
      const { error: updateError } = await supabaseAdmin
        .from('subscriptions')
        .update({
          status: stripeSubscription.status,
          current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
          cancel_at_period_end: stripeSubscription.cancel_at_period_end,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscriptionId);

      if (updateError) {
        logWebhookEvent('Error updating existing subscription', updateError);
        throw updateError;
      }
      return existingData;
    }

    // Create a new subscription - ensure valid data for all required fields
    const newSubscription = {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      status: stripeSubscription.status,
      price_id: stripeSubscription.items.data[0]?.price.id || 'unknown',
      current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: stripeSubscription.cancel_at_period_end,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    logWebhookEvent('Creating new subscription record with data', newSubscription);
    
    const { data, error: insertError } = await supabaseAdmin
      .from('subscriptions')
      .insert(newSubscription);

    if (insertError) {
      logWebhookEvent('Error inserting new subscription', insertError);
      throw insertError;
    }

    // Verify the subscription was created
    const { data: verifyData, error: verifyError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('stripe_subscription_id', subscriptionId)
      .single();
      
    if (verifyError || !verifyData) {
      logWebhookEvent('Failed to verify subscription creation', { verifyError });
    } else {
      logWebhookEvent('Successfully verified subscription creation', verifyData);
    }

    logWebhookEvent('Successfully created new subscription', data);
    return data || verifyData;
  } catch (error) {
    logWebhookEvent('Error in createSubscription', error);
    throw error;
  }
} 