import fs from 'fs';

async function run() {
  try {
    const registerResp = await fetch('http://localhost:5000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `tempnode${Date.now()}`, email: `tempnode${Date.now()}@example.com`, password: 'Testpass123!', firstName: 'T', lastName: 'U' })
    });

    const regJson = await registerResp.json();
    fs.writeFileSync('resp_register.json', JSON.stringify(regJson, null, 2));
    console.log('Register response saved to resp_register.json');

    if (!regJson.data || !regJson.data.token) {
      console.error('No token returned');
      return;
    }

    const token = regJson.data.token;

    const orderResp = await fetch('http://localhost:5000/api/payments/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ planId: 'STARTER' })
    });

    const orderJson = await orderResp.json();
    fs.writeFileSync('resp_create_order.json', JSON.stringify(orderJson, null, 2));
    console.log('Create-order response saved to resp_create_order.json');
    console.log('Status:', orderResp.status);
    console.log(orderJson);
  } catch (err) {
    console.error('Request error:', err);
  }
}

run();
