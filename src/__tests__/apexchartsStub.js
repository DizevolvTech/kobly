// ApexCharts precisa de SVG real (jsdom não tem). Nos testes de interface, o desenho
// do gráfico não é o alvo: troca por um stub via alias em vite.config.js (test.alias).
export default class ApexChartsStub { render() {} updateOptions() {} updateSeries() {} destroy() {} }
