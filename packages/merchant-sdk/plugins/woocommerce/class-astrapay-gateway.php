<?php
/**
 * Plugin Name: PayNova Payment Gateway for WooCommerce
 * Plugin URI: https://paynova.in
 * Description: Zero-fee instant UPI payment gateway with live banking observer settlement.
 * Version: 1.0.0
 * Author: PayNova
 * Author URI: https://paynova.in
 * License: GPLv2 or later
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('plugins_loaded', 'astrapay_gateway_init', 11);

function astrapay_gateway_init() {
    if (!class_exists('WC_Payment_Gateway')) return;

    class WC_Gateway_AstraPay extends WC_Payment_Gateway {
        public function __construct() {
            $this->id = 'paynova';
            $this->icon = apply_filters('woocommerce_paynova_icon', '');
            $this->has_fields = false;
            $this->method_title = __('PayNova UPI', 'woocommerce');
            $this->method_description = __('Zero-fee direct UPI payment gateway with instant QR code and 1-tap mobile UPI app chooser.', 'woocommerce');

            $this->init_form_fields();
            $this->init_settings();

            $this->title = $this->get_option('title', 'Pay via UPI / QR (PayNova)');
            $this->description = $this->get_option('description', 'Instant scan & pay via Google Pay, PhonePe, Paytm, CRED or any UPI App.');
            $this->gateway_url = rtrim($this->get_option('gateway_url', 'http://localhost:7000'), '/');
            $this->merchant_id = $this->get_option('merchant_id', '00000000-0000-0000-0000-000000000001');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
            add_action('wp_enqueue_scripts', array($this, 'payment_scripts'));
        }

        public function init_form_fields() {
            $this->form_fields = array(
                'enabled' => array(
                    'title'   => __('Enable/Disable', 'woocommerce'),
                    'type'    => 'checkbox',
                    'label'   => __('Enable AstraPay UPI Gateway', 'woocommerce'),
                    'default' => 'yes'
                ),
                'title' => array(
                    'title'       => __('Title', 'woocommerce'),
                    'type'        => 'text',
                    'description' => __('Payment method title that the customer sees during checkout.', 'woocommerce'),
                    'default'     => __('Pay via UPI / QR (AstraPay)', 'woocommerce'),
                    'desc_tip'    => true,
                ),
                'description' => array(
                    'title'       => __('Description', 'woocommerce'),
                    'type'        => 'textarea',
                    'description' => __('Payment method description that the customer sees during checkout.', 'woocommerce'),
                    'default'     => __('Instant scan & pay via Google Pay, PhonePe, Paytm, CRED or any UPI App.', 'woocommerce'),
                ),
                'gateway_url' => array(
                    'title'       => __('Gateway URL / Cloudflare Tunnel', 'woocommerce'),
                    'type'        => 'text',
                    'description' => __('Public HTTPS URL of your checkout portal (e.g., https://checkout.hackastra.com or Cloudflare tunnel URL).', 'woocommerce'),
                    'default'     => 'http://localhost:7000',
                ),
                'merchant_id' => array(
                    'title'       => __('Merchant ID', 'woocommerce'),
                    'type'        => 'text',
                    'description' => __('Your Hackastra Merchant UUID.', 'woocommerce'),
                    'default'     => '00000000-0000-0000-0000-000000000001',
                )
            );
        }

        public function payment_scripts() {
            if (!is_checkout()) return;
            wp_enqueue_script('astrapay_sdk', $this->gateway_url . '/astrapay.js', array(), '1.0.0', true);
        }

        public function process_payment($order_id) {
            $order = wc_get_order($order_id);
            $amount = $order->get_total();
            $customer_name = $order->get_billing_first_name() . ' ' . $order->get_billing_last_name();
            $customer_email = $order->get_billing_email();
            $customer_phone = $order->get_billing_phone();

            $checkout_session_url = $this->gateway_url . '/checkout?merchantId=' . urlencode($this->merchant_id) .
                '&orderId=' . urlencode('WC-' . $order_id) .
                '&amount=' . urlencode($amount) .
                '&customerName=' . urlencode($customer_name) .
                '&customerEmail=' . urlencode($customer_email) .
                '&customerPhone=' . urlencode($customer_phone) .
                '&returnUrl=' . urlencode($this->get_return_url($order));

            return array(
                'result'   => 'success',
                'redirect' => $checkout_session_url
            );
        }
    }
}

add_filter('woocommerce_payment_gateways', 'add_astrapay_gateway_class');
function add_astrapay_gateway_class($methods) {
    $methods[] = 'WC_Gateway_AstraPay';
    return $methods;
}
