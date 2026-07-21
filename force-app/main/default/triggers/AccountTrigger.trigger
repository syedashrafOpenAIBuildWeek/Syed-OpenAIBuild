trigger AccountTrigger on Account (before insert) {
    for (Account acc : Trigger.new) {
        acc.TickerSymbol = 'Ticker';
        acc.Level__c = 'Primary';
        acc.Account_Date__c = Date.today();
    }
}