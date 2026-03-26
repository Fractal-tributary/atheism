const os = require('os');

const networkInterfaces = os.networkInterfaces();
const addresses = [];

for (const name of Object.keys(networkInterfaces)) {
  for (const net of networkInterfaces[name]) {
    // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
    if (net.family === 'IPv4' && !net.internal) {
      addresses.push({
        interface: name,
        address: net.address
      });
    }
  }
}

console.log('本机内网地址:');
addresses.forEach(({ interface, address }) => {
  console.log(`  ${interface}: ${address}`);
});

if (addresses.length > 0) {
  console.log(`\n推荐使用: ${addresses[0].address}`);
}
